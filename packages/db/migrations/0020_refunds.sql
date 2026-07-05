-- ============================================================================
-- FLUVIA 0020_refunds.sql  (F3-08 — refunds end-to-end)
--
-- La tabla `refunds` materializa la FSM de refund que existe desde F3-01
-- (mapa TS + mermaid §3 de payment-state-machines.md) y la hace cumplir EN el
-- motor con el mismo patrón de 0017: tabla de transiciones INMUTABLE sembrada
-- desde el mapa TS (scripts/gen-fsm-seed.ts, patrón golden) + trigger de
-- validación. El invariante Σ refunds ≤ capturado ya vive en el CHECK
-- `payment_intents_refunded_le_captured` de 0017; aquí se añade la pieza
-- operativa (filas de refund + su máquina de estados).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. refunds
-- ----------------------------------------------------------------------------
CREATE TABLE refunds (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES organizations(id),
  payment_intent_id UUID NOT NULL,
  amount            BIGINT NOT NULL CHECK (amount > 0),
  currency          CHAR(3) NOT NULL,
  status            TEXT NOT NULL DEFAULT 'created' CHECK (status IN (
    'created', 'processing', 'indeterminate', 'succeeded', 'failed', 'canceled'
  )),
  reason            TEXT,
  failure_code      TEXT,
  provider          TEXT NOT NULL,
  provider_ref      TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at       TIMESTAMPTZ,
  UNIQUE (id, tenant_id),
  -- Patrón AUD-P1-001: un refund jamás puede apuntar al intent de otro tenant.
  CONSTRAINT refunds_intent_coherence_fk
    FOREIGN KEY (payment_intent_id, tenant_id) REFERENCES payment_intents (id, tenant_id)
);

CREATE INDEX refunds_tenant_intent_idx ON refunds (tenant_id, payment_intent_id);

CREATE TRIGGER refunds_no_delete
  BEFORE DELETE ON refunds
  FOR EACH ROW EXECUTE FUNCTION fluvia_forbid_mutation();
CREATE TRIGGER refunds_no_truncate
  BEFORE TRUNCATE ON refunds
  FOR EACH STATEMENT EXECUTE FUNCTION fluvia_forbid_mutation();

ALTER TABLE refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE refunds FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON refunds
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON refunds TO fluvia_app;

-- ----------------------------------------------------------------------------
-- 2. Tabla de transiciones (referencia inmutable; fuente = mapa TS)
-- ----------------------------------------------------------------------------
CREATE TABLE refund_transitions (
  from_status TEXT NOT NULL,
  to_status   TEXT NOT NULL,
  PRIMARY KEY (from_status, to_status)
);

-- Seed GENERADO por @fluvia/payments-core scripts/gen-fsm-seed.ts — no editar
-- a mano (el meta-test compara la tabla contra el mapa TS).
INSERT INTO refund_transitions (from_status, to_status) VALUES
  ('created', 'canceled'),
  ('created', 'processing'),
  ('indeterminate', 'failed'),
  ('indeterminate', 'succeeded'),
  ('processing', 'failed'),
  ('processing', 'indeterminate'),
  ('processing', 'succeeded');

-- Inmutable: cambiar la FSM exige una migración nueva, jamás un UPDATE.
CREATE TRIGGER refund_transitions_no_update
  BEFORE UPDATE ON refund_transitions
  FOR EACH ROW EXECUTE FUNCTION fluvia_forbid_mutation();
CREATE TRIGGER refund_transitions_no_delete
  BEFORE DELETE ON refund_transitions
  FOR EACH ROW EXECUTE FUNCTION fluvia_forbid_mutation();
CREATE TRIGGER refund_transitions_no_truncate
  BEFORE TRUNCATE ON refund_transitions
  FOR EACH STATEMENT EXECUTE FUNCTION fluvia_forbid_mutation();

-- Solo lectura y SOLO para fluvia_app (el trigger corre con los privilegios
-- del invocador; fluvia_worker sigue siendo cascarón — ADR-0011).
GRANT SELECT ON refund_transitions TO fluvia_app;
REVOKE ALL ON refund_transitions FROM fluvia_worker, fluvia_relay, fluvia_inbox, fluvia_auth, fluvia_webhook;
REVOKE INSERT, UPDATE, DELETE ON refund_transitions FROM fluvia_app;

-- ----------------------------------------------------------------------------
-- 3. Trigger de validación (el MOTOR decide, no el servicio)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fluvia_validate_refund_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM refund_transitions
    WHERE from_status = OLD.status AND to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'FLUVIA_INVALID_TRANSITION: refund % -> % is not a legal transition',
      OLD.status, NEW.status
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER refunds_fsm_guard
  BEFORE UPDATE OF status ON refunds
  FOR EACH ROW EXECUTE FUNCTION fluvia_validate_refund_transition();
