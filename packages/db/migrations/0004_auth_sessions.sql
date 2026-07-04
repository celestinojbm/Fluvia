-- ============================================================================
-- FLUVIA 0004_auth_sessions.sql  (F1-04a)
--
-- Plano de autenticacion: sesiones revocables, verificacion de email y
-- lockout por intentos fallidos.
--
-- Modelo de acceso:
--   * Nuevo rol `fluvia_auth`: UNICO rol con acceso a users/sessions/
--     email_verification_tokens (politica USING(true) acotada AL ROL).
--     Lo usa exclusivamente el modulo de auth del API.
--   * `fluvia_app` y `fluvia_worker`: acceso REVOCADO a sessions/tokens.
--     La API de negocio jamas toca credenciales.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Lockout de login en users
-- ----------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN failed_login_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN locked_until TIMESTAMPTZ;

-- ----------------------------------------------------------------------------
-- 2. Sesiones (token en claro JAMAS se persiste; solo SHA-256)
-- ----------------------------------------------------------------------------
CREATE TABLE sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id),
  token_hash    TEXT NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip            TEXT,
  user_agent    TEXT
);

CREATE INDEX sessions_user_idx ON sessions (user_id);

-- ----------------------------------------------------------------------------
-- 3. Tokens de verificacion de email (un solo uso, con expiracion)
-- ----------------------------------------------------------------------------
CREATE TABLE email_verification_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id),
  token_hash   TEXT NOT NULL UNIQUE,
  expires_at   TIMESTAMPTZ NOT NULL,
  consumed_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX email_verification_tokens_user_idx ON email_verification_tokens (user_id);

-- Clasificacion "tecnico": sesiones/tokens expirados seran purgables por job
-- administrado (F1-09). Hasta entonces aplica la politica por defecto:
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['sessions', 'email_verification_tokens']
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
-- 4. Rol fluvia_auth y modelo de acceso
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fluvia_auth') THEN
    -- Password SOLO para desarrollo local (igual que 0002); en cloud se
    -- aprovisiona por infraestructura.
    CREATE ROLE fluvia_auth LOGIN PASSWORD 'fluvia_auth_dev_password';
  END IF;
END;
$$;

GRANT USAGE ON SCHEMA public TO fluvia_auth;
GRANT SELECT, INSERT, UPDATE ON users, sessions, email_verification_tokens TO fluvia_auth;

-- Los default privileges de 0002 les dieron acceso automatico a app/worker
-- sobre las tablas nuevas: se revoca. Credenciales = solo plano de auth.
REVOKE ALL ON sessions, email_verification_tokens FROM fluvia_app, fluvia_worker;

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE email_verification_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_verification_tokens FORCE ROW LEVEL SECURITY;

-- Politicas acotadas AL ROL fluvia_auth (autenticacion ocurre antes de que
-- exista contexto de tenant; el aislamiento aqui es por rol, no por fila).
CREATE POLICY auth_plane_access ON users
  FOR ALL TO fluvia_auth USING (true) WITH CHECK (true);
CREATE POLICY auth_plane_access ON sessions
  FOR ALL TO fluvia_auth USING (true) WITH CHECK (true);
CREATE POLICY auth_plane_access ON email_verification_tokens
  FOR ALL TO fluvia_auth USING (true) WITH CHECK (true);

-- ----------------------------------------------------------------------------
-- 5. Membresias del usuario autenticado (para elegir contexto de tenant tras
--    el login). SECURITY DEFINER acotado: solo lectura de pares org/rol.
-- ----------------------------------------------------------------------------
CREATE FUNCTION auth_list_memberships(p_user_id UUID)
RETURNS TABLE (organization_id UUID, organization_name TEXT, organization_slug TEXT, role TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT o.id, o.name, o.slug, m.role
  FROM memberships m
  JOIN organizations o ON o.id = m.tenant_id AND o.deleted_at IS NULL
  WHERE m.user_id = p_user_id
    AND m.revoked_at IS NULL
  ORDER BY m.created_at;
$$;

REVOKE ALL ON FUNCTION auth_list_memberships(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_list_memberships(UUID) TO fluvia_auth;
