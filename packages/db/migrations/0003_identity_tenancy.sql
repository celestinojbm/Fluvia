-- ============================================================================
-- FLUVIA 0003_identity_tenancy.sql  (F1-03)
--
-- Expand: el `tenants` del spike se convierte en el modelo real de identidad:
--   organizations (rename) · users · memberships · merchants
--
-- Nota expand-and-contract: el rename directo es seguro porque no existe
-- ningun consumidor desplegado de `tenants` (pre-sandbox); la fase "contract"
-- es trivial y queda documentada en database-schema.md. La convencion de
-- columna `tenant_id` (= organization id) se CONSERVA en todo el esquema.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. tenants -> organizations
-- ----------------------------------------------------------------------------
ALTER TABLE tenants RENAME TO organizations;
ALTER TRIGGER tenants_no_delete ON organizations RENAME TO organizations_no_delete;
ALTER TRIGGER tenants_no_truncate ON organizations RENAME TO organizations_no_truncate;

-- Identificador publico legible (ademas del UUID). Backfill determinista para
-- filas del spike; unico e inmutable a nivel de servicio.
ALTER TABLE organizations ADD COLUMN slug TEXT;
UPDATE organizations SET slug = 'org-' || id::text WHERE slug IS NULL;
ALTER TABLE organizations ALTER COLUMN slug SET NOT NULL;
ALTER TABLE organizations ADD CONSTRAINT organizations_slug_key UNIQUE (slug);

-- ----------------------------------------------------------------------------
-- 2. users (GLOBAL: un usuario puede pertenecer a varias organizaciones)
-- ----------------------------------------------------------------------------
CREATE TABLE users (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email              TEXT NOT NULL,
  email_verified_at  TIMESTAMPTZ,
  -- Se llena en F1-04 (auth). Nullable hasta entonces: ningun login es posible
  -- sin hash, por lo que no existe ventana de cuenta-sin-password utilizable.
  password_hash      TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at         TIMESTAMPTZ
);

CREATE UNIQUE INDEX users_email_unique ON users (lower(email)) WHERE deleted_at IS NULL;

-- ----------------------------------------------------------------------------
-- 3. memberships (user <-> organization con rol RBAC)
-- ----------------------------------------------------------------------------
CREATE TABLE memberships (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES organizations(id),
  user_id     UUID NOT NULL REFERENCES users(id),
  role        TEXT NOT NULL CHECK (
    role IN ('owner', 'admin', 'developer', 'finance', 'support', 'analyst', 'read_only')
  ),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at  TIMESTAMPTZ,
  UNIQUE (tenant_id, user_id)
);

CREATE INDEX memberships_user_idx ON memberships (user_id);

-- ----------------------------------------------------------------------------
-- 4. merchants (subdivision comercial del tenant; autorizacion de aplicacion)
-- ----------------------------------------------------------------------------
CREATE TABLE merchants (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES organizations(id),
  name              TEXT NOT NULL,
  country           CHAR(2) NOT NULL DEFAULT 'CO',
  default_currency  CHAR(3) NOT NULL DEFAULT 'COP',
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'frozen')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ,
  UNIQUE (tenant_id, name)
);

CREATE INDEX merchants_tenant_idx ON merchants (tenant_id);

-- ----------------------------------------------------------------------------
-- 5. Inmutabilidad (sin DELETE/TRUNCATE; bajas via deleted_at / revoked_at)
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['users', 'memberships', 'merchants']
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION fluvia_forbid_mutation()',
      t || '_no_delete', t
    );
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION fluvia_forbid_mutation()',
      t || '_no_truncate', t
    );
  END LOOP;
END;
$$;

-- ----------------------------------------------------------------------------
-- 6. RLS
-- ----------------------------------------------------------------------------
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE merchants ENABLE ROW LEVEL SECURITY;
ALTER TABLE merchants FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON memberships
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation ON merchants
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- users es global: el rol de API solo puede VER usuarios que comparten una
-- membresia activa con el tenant en contexto. Sin politica de INSERT/UPDATE:
-- el registro de usuarios es plano de plataforma (F1-04 definira el camino
-- sancionado). FORCE RLS => escritura denegada para fluvia_app por defecto.
CREATE POLICY user_visible_via_membership ON users
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM memberships m
      WHERE m.user_id = users.id
        AND m.revoked_at IS NULL
        AND m.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    )
  );

-- ----------------------------------------------------------------------------
-- 7. authenticate_api_key: el cuerpo SQL referencia la tabla por nombre en
--    ejecucion; tras el rename DEBE recrearse apuntando a organizations.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION authenticate_api_key(p_key_hash TEXT)
RETURNS TABLE (tenant_id UUID, api_key_id UUID)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT ak.tenant_id, ak.id
  FROM api_keys ak
  JOIN organizations o ON o.id = ak.tenant_id AND o.deleted_at IS NULL
  WHERE ak.key_hash = p_key_hash
    AND ak.revoked_at IS NULL
    AND ak.deleted_at IS NULL;
$$;
