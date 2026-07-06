-- ============================================================================
-- FLUVIA 0036_disputes.sql  (F4-08a — disputas/chargebacks como recurso gestionado)
--
-- Materializa el RECURSO de disputa (money clawed back) sobre la cuenta
-- `dispute.reserve` (merchant-scope, credit-normal) que ya vive en el Chart of
-- Accounts esperando su motor. Mismo patrón que payouts (0033) / refunds (0020):
-- fila mutable con FSM hecha cumplir EN el motor por una tabla de transiciones
-- INMUTABLE (sembrada desde el mapa TS de @fluvia/payments-core src/fsm.ts,
-- patrón golden) + trigger de validación.
--
-- Contable (mismo esqueleto que refunds; sin double-spend por el guard
-- AUD-P1-010): al ABRIR se aparta el monto disputado del disponible del comercio
-- (`openDispute`: merchant.available -> dispute.reserve); `won` lo devuelve
-- íntegro (`winDispute`: dispute.reserve -> merchant.available); `lost` lo
-- forfeita al proveedor (`loseDispute`: dispute.reserve -> provider.clearing,
-- como un refund forzado). El desenlace llega SIEMPRE de fuente verificada.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. `dispute` como causa contable (V4: el `reason` es causal y preciso).
--    Idempotente (DROP IF EXISTS + ADD), como 0031 (reserve).
-- ----------------------------------------------------------------------------
ALTER TABLE ledger_transactions DROP CONSTRAINT IF EXISTS ledger_transactions_reason_check;
ALTER TABLE ledger_transactions ADD CONSTRAINT ledger_transactions_reason_check CHECK (
  reason IN (
    'payment', 'refund', 'fee', 'payout', 'transfer',
    'adjustment', 'settlement', 'reversal', 'reconciliation', 'reserve', 'dispute'
  )
);

-- ----------------------------------------------------------------------------
-- 1. disputes
-- ----------------------------------------------------------------------------
CREATE TABLE disputes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES organizations(id),
  merchant_id   UUID NOT NULL,
  amount        BIGINT NOT NULL CHECK (amount > 0),
  currency      CHAR(3) NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN (
    'open', 'under_review', 'won', 'lost'
  )),
  -- Categoría de la disputa según el banco (fraudulent, product_not_received…).
  reason        TEXT,
  provider      TEXT NOT NULL,
  -- Referencia del banco/proveedor a la disputa o al cargo disputado.
  provider_ref  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at   TIMESTAMPTZ,
  UNIQUE (id, tenant_id),
  -- Patrón AUD-P1-001: una disputa jamás puede apuntar al merchant de otro tenant.
  CONSTRAINT disputes_merchant_coherence_fk
    FOREIGN KEY (merchant_id, tenant_id) REFERENCES merchants (id, tenant_id)
);

CREATE INDEX disputes_tenant_merchant_idx ON disputes (tenant_id, merchant_id);

CREATE TRIGGER disputes_no_delete
  BEFORE DELETE ON disputes
  FOR EACH ROW EXECUTE FUNCTION fluvia_forbid_mutation();
CREATE TRIGGER disputes_no_truncate
  BEFORE TRUNCATE ON disputes
  FOR EACH STATEMENT EXECUTE FUNCTION fluvia_forbid_mutation();

ALTER TABLE disputes ENABLE ROW LEVEL SECURITY;
ALTER TABLE disputes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON disputes
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON disputes TO fluvia_app;

-- ----------------------------------------------------------------------------
-- 2. Tabla de transiciones (referencia inmutable; fuente = mapa TS)
-- ----------------------------------------------------------------------------
CREATE TABLE dispute_transitions (
  from_status TEXT NOT NULL,
  to_status   TEXT NOT NULL,
  PRIMARY KEY (from_status, to_status)
);

-- Seed GENERADO por @fluvia/payments-core scripts/gen-fsm-seed.ts — no editar
-- a mano (el meta-test compara la tabla contra el mapa TS DISPUTE_TRANSITIONS).
INSERT INTO dispute_transitions (from_status, to_status) VALUES
  ('open', 'lost'),
  ('open', 'under_review'),
  ('open', 'won'),
  ('under_review', 'lost'),
  ('under_review', 'won');

-- Inmutable: cambiar la FSM exige una migración nueva, jamás un UPDATE.
CREATE TRIGGER dispute_transitions_no_update
  BEFORE UPDATE ON dispute_transitions
  FOR EACH ROW EXECUTE FUNCTION fluvia_forbid_mutation();
CREATE TRIGGER dispute_transitions_no_delete
  BEFORE DELETE ON dispute_transitions
  FOR EACH ROW EXECUTE FUNCTION fluvia_forbid_mutation();
CREATE TRIGGER dispute_transitions_no_truncate
  BEFORE TRUNCATE ON dispute_transitions
  FOR EACH STATEMENT EXECUTE FUNCTION fluvia_forbid_mutation();

-- Solo lectura y SOLO para fluvia_app (el trigger corre con los privilegios del
-- invocador; fluvia_worker sigue siendo cascarón — ADR-0011).
GRANT SELECT ON dispute_transitions TO fluvia_app;
REVOKE ALL ON dispute_transitions FROM fluvia_worker, fluvia_relay, fluvia_inbox, fluvia_auth, fluvia_webhook;
REVOKE INSERT, UPDATE, DELETE ON dispute_transitions FROM fluvia_app;

-- ----------------------------------------------------------------------------
-- 3. Trigger de validación (el MOTOR decide, no el servicio)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fluvia_validate_dispute_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM dispute_transitions
    WHERE from_status = OLD.status AND to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'FLUVIA_INVALID_TRANSITION: dispute % -> % is not a legal transition',
      OLD.status, NEW.status
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER disputes_fsm_guard
  BEFORE UPDATE OF status ON disputes
  FOR EACH ROW EXECUTE FUNCTION fluvia_validate_dispute_transition();
