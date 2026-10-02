-- ============================================================================
-- FLUVIA 0057_business_profiles.sql  (jornada restaurantes y cobro presencial)
--
-- 1. business_profiles: tipo de negocio de la organización (minorista,
--    restaurante, cafetería/comida rápida, servicios/independiente) y los
--    módulos que habilita. Es CONFIGURACIÓN sobre la misma organización,
--    catálogo, permisos y contabilidad: cambiarla no borra ni mueve datos
--    (los módulos se ocultan o muestran; los datos quedan). Versión optimista.
--
-- 2. collection_enablements: habilitación EXPLÍCITA para recibir cobros
--    presenciales (Tap to Pay / lector externo). Estados: pending, enabled,
--    restricted, suspended. Una cuenta Personal no la adquiere por existir;
--    una organización nueva empieza en `pending`. Cada cambio queda en
--    collection_enablement_events (append-only).
--
-- 3. Rol de membresía `staff`: personal operativo (cajero, mesero, cocina)
--    con SOLO `org:read` en la matriz RBAC — no ve el plano financiero del
--    panel. Lo que puede hacer en el local lo da venue_staff (rol de local y,
--    opcionalmente, sucursal), verificado en el servidor en cada acción.
--
-- Aditiva: columnas/tablas nuevas y ampliación del CHECK de roles.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Perfil de negocio
-- ----------------------------------------------------------------------------
CREATE TABLE business_profiles (
  tenant_id     UUID PRIMARY KEY REFERENCES organizations(id),
  business_type TEXT NOT NULL CHECK (
    business_type IN ('retail', 'restaurant', 'quick_service', 'services')
  ),
  -- Módulos habilitados (lista cerrada; el tipo propone un conjunto y el
  -- comercio puede ajustarlo). Ninguno borra datos al desactivarse.
  modules       TEXT[] NOT NULL DEFAULT '{}' CHECK (
    modules <@ ARRAY['catalog', 'inventory', 'pos', 'tables', 'kitchen', 'qr_menu',
                     'customer_orders', 'split_bill', 'in_person', 'payment_links']::TEXT[]
  ),
  -- Independiente: interfaz simple de «Cobrar» (sin catálogo ni sucursales).
  solo          BOOLEAN NOT NULL DEFAULT false,
  -- El comercio decide si los pedidos del cliente (QR) requieren aceptación.
  customer_orders_need_acceptance BOOLEAN NOT NULL DEFAULT true,
  version       INT NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE business_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON business_profiles
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON business_profiles TO fluvia_app;
CREATE TRIGGER business_profiles_no_delete
  BEFORE DELETE ON business_profiles FOR EACH ROW EXECUTE FUNCTION fluvia_forbid_mutation();

-- ----------------------------------------------------------------------------
-- 2. Habilitación de cobro presencial
-- ----------------------------------------------------------------------------
CREATE TABLE collection_enablements (
  tenant_id   UUID NOT NULL REFERENCES organizations(id),
  method      TEXT NOT NULL CHECK (method IN ('in_person')),
  status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'enabled', 'restricted', 'suspended')),
  -- Requisitos del proveedor (lista declarativa con estado de cada uno).
  requirements JSONB NOT NULL DEFAULT '[]'::jsonb,
  reason      TEXT CHECK (reason IS NULL OR char_length(reason) <= 280),
  provider    TEXT NOT NULL DEFAULT 'none' CHECK (char_length(provider) BETWEEN 1 AND 40),
  version     INT NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, method)
);
ALTER TABLE collection_enablements ENABLE ROW LEVEL SECURITY;
ALTER TABLE collection_enablements FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON collection_enablements
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON collection_enablements TO fluvia_app;
CREATE TRIGGER collection_enablements_no_delete
  BEFORE DELETE ON collection_enablements FOR EACH ROW EXECUTE FUNCTION fluvia_forbid_mutation();

CREATE TABLE collection_enablement_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES organizations(id),
  method      TEXT NOT NULL,
  from_status TEXT,
  to_status   TEXT NOT NULL,
  reason      TEXT,
  actor_id    UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX collection_enablement_events_idx
  ON collection_enablement_events (tenant_id, created_at DESC);
ALTER TABLE collection_enablement_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE collection_enablement_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON collection_enablement_events
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON collection_enablement_events TO fluvia_app;
CREATE TRIGGER collection_enablement_events_no_update
  BEFORE UPDATE OR DELETE ON collection_enablement_events
  FOR EACH ROW EXECUTE FUNCTION fluvia_forbid_mutation();

-- ----------------------------------------------------------------------------
-- 3. Rol de membresía `staff` (solo org:read en RBAC)
-- ----------------------------------------------------------------------------
ALTER TABLE memberships DROP CONSTRAINT memberships_role_check;
ALTER TABLE memberships ADD CONSTRAINT memberships_role_check CHECK (
  role IN ('owner', 'admin', 'developer', 'finance', 'support', 'analyst', 'read_only', 'staff')
);
