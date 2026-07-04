-- ============================================================================
-- FLUVIA 0006_audit_log.sql  (F1-05)
--
-- Audit log append-only (V4 §36). Los eventos se insertan EN LA MISMA
-- transaccion que la accion auditada: o se confirman ambas o ninguna.
--
-- Inmutabilidad en tres capas: triggers (UPDATE/DELETE/TRUNCATE), ausencia
-- de grant de UPDATE, y clasificacion financiero-inmutable (sin purga).
-- ============================================================================

CREATE TABLE audit_events (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- NULL para eventos del plano de autenticacion (pre-tenant).
  tenant_id       UUID REFERENCES organizations(id),
  actor_type      TEXT NOT NULL CHECK (actor_type IN ('user', 'api_key', 'system')),
  actor_id        UUID,
  auth_method     TEXT CHECK (auth_method IN ('session', 'api_key', 'platform', 'none')),
  action          TEXT NOT NULL,
  resource_type   TEXT,
  resource_id     TEXT,
  result          TEXT NOT NULL DEFAULT 'success' CHECK (result IN ('success', 'failure')),
  risk_level      TEXT NOT NULL DEFAULT 'low' CHECK (risk_level IN ('low', 'medium', 'high')),
  reason          TEXT,
  -- Resumenes de estado anterior/posterior. El llamador redacta secretos;
  -- JAMAS se guardan tokens, hashes ni credenciales completas aqui.
  before_summary  JSONB,
  after_summary   JSONB,
  ip              TEXT,
  user_agent      TEXT,
  request_id      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_tenant_idx ON audit_events (tenant_id, id DESC);
CREATE INDEX audit_events_actor_idx ON audit_events (actor_id, id DESC);

-- Append-only a nivel de motor.
CREATE TRIGGER audit_events_no_update
  BEFORE UPDATE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION fluvia_forbid_mutation();
CREATE TRIGGER audit_events_no_delete
  BEFORE DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION fluvia_forbid_mutation();
CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION fluvia_forbid_mutation();

-- Defensa por grants: nadie (salvo owner de migraciones) tiene UPDATE.
REVOKE UPDATE ON audit_events FROM fluvia_app, fluvia_worker;
GRANT INSERT ON audit_events TO fluvia_auth;

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;

-- Plano de tenant: lee/escribe SOLO eventos de su tenant (contexto SET LOCAL).
CREATE POLICY tenant_isolation ON audit_events
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Plano de auth: SOLO INSERT y SOLO eventos sin tenant (login, registro...).
CREATE POLICY auth_plane_audit ON audit_events
  FOR INSERT TO fluvia_auth
  WITH CHECK (tenant_id IS NULL);
