-- ============================================================================
-- FLUVIA 0022_checkout_sessions.sql  (F3-05b — checkout sessions)
--
-- Sesión de checkout alojado: referencia a un payment_intent (y opcionalmente
-- un customer), con `client_secret` (credencial de la página alojada — se
-- guarda SOLO su hash, como las API keys) y una FSM open→completed|expired
-- hecha cumplir EN el motor con el patrón golden de 0017/0020/0021.
--
-- Alcance F3-05b: el recurso (crear/consultar por el comercio). El disparo de
-- completed/expired, el retrieval por client_secret y los eventos
-- `checkout_session.*` llegan con el flujo alojado (F3-05c).
-- ============================================================================

CREATE TABLE checkout_sessions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES organizations(id),
  payment_intent_id  UUID NOT NULL,
  customer_id        UUID,
  status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'expired')),
  -- Solo el hash del client_secret: un dump no permite secuestrar sesiones.
  client_secret_hash TEXT NOT NULL,
  success_url        TEXT,
  cancel_url         TEXT,
  expires_at         TIMESTAMPTZ NOT NULL,
  completed_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  -- Patrón AUD-P1-001: la sesión jamás cruza tenant, ni hacia el intent ni el
  -- customer (ambos FK compuestos con tenant_id).
  CONSTRAINT checkout_sessions_intent_coherence_fk
    FOREIGN KEY (payment_intent_id, tenant_id) REFERENCES payment_intents (id, tenant_id),
  CONSTRAINT checkout_sessions_customer_coherence_fk
    FOREIGN KEY (customer_id, tenant_id) REFERENCES customers (id, tenant_id)
);

CREATE INDEX checkout_sessions_tenant_idx ON checkout_sessions (tenant_id, created_at);
CREATE INDEX checkout_sessions_intent_idx ON checkout_sessions (payment_intent_id);
-- El barrido de expiración (F3-05c) buscará por (status, expires_at).
CREATE INDEX checkout_sessions_open_idx ON checkout_sessions (expires_at)
  WHERE status = 'open';

CREATE TRIGGER checkout_sessions_no_delete
  BEFORE DELETE ON checkout_sessions
  FOR EACH ROW EXECUTE FUNCTION fluvia_forbid_mutation();
CREATE TRIGGER checkout_sessions_no_truncate
  BEFORE TRUNCATE ON checkout_sessions
  FOR EACH STATEMENT EXECUTE FUNCTION fluvia_forbid_mutation();

ALTER TABLE checkout_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE checkout_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON checkout_sessions
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON checkout_sessions TO fluvia_app;

-- ----------------------------------------------------------------------------
-- Tabla de transiciones (referencia inmutable; fuente = mapa TS)
-- ----------------------------------------------------------------------------
CREATE TABLE checkout_session_transitions (
  from_status TEXT NOT NULL,
  to_status   TEXT NOT NULL,
  PRIMARY KEY (from_status, to_status)
);

-- Seed GENERADO por @fluvia/payments-core scripts/gen-fsm-seed.ts — no editar
-- a mano (el meta-test compara la tabla contra el mapa TS).
INSERT INTO checkout_session_transitions (from_status, to_status) VALUES
  ('open', 'completed'),
  ('open', 'expired');

CREATE TRIGGER checkout_session_transitions_no_update
  BEFORE UPDATE ON checkout_session_transitions
  FOR EACH ROW EXECUTE FUNCTION fluvia_forbid_mutation();
CREATE TRIGGER checkout_session_transitions_no_delete
  BEFORE DELETE ON checkout_session_transitions
  FOR EACH ROW EXECUTE FUNCTION fluvia_forbid_mutation();
CREATE TRIGGER checkout_session_transitions_no_truncate
  BEFORE TRUNCATE ON checkout_session_transitions
  FOR EACH STATEMENT EXECUTE FUNCTION fluvia_forbid_mutation();

GRANT SELECT ON checkout_session_transitions TO fluvia_app;
REVOKE ALL ON checkout_session_transitions
  FROM fluvia_worker, fluvia_relay, fluvia_inbox, fluvia_auth, fluvia_webhook;
REVOKE INSERT, UPDATE, DELETE ON checkout_session_transitions FROM fluvia_app;

CREATE OR REPLACE FUNCTION fluvia_validate_checkout_session_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM checkout_session_transitions
    WHERE from_status = OLD.status AND to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'FLUVIA_INVALID_TRANSITION: checkout_session % -> % is not a legal transition',
      OLD.status, NEW.status
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER checkout_sessions_fsm_guard
  BEFORE UPDATE OF status ON checkout_sessions
  FOR EACH ROW EXECUTE FUNCTION fluvia_validate_checkout_session_transition();
