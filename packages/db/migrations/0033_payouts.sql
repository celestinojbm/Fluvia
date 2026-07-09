-- ============================================================================
-- FLUVIA 0033_payouts.sql  (F4-07a — payouts como recurso gestionado)
--
-- Materializa el RECURSO de payout (money out) sobre las primitivas contables
-- de F4-05b (emitPayout/settlePayout/failPayout, flujo available -> in_transit
-- -> cash). Mismo patrón que refunds (0020): fila mutable con FSM hecha cumplir
-- EN el motor por una tabla de transiciones INMUTABLE (sembrada desde el mapa TS
-- de @fluvia/payments-core src/fsm.ts, patrón golden) + trigger de validación.
-- El invariante de no-double-spend (no emitir más de lo disponible) ya vive en
-- el guard AUD-P1-010 del motor contable; aquí se añade la pieza operativa.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. payouts
-- ----------------------------------------------------------------------------
CREATE TABLE payouts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES organizations(id),
  merchant_id   UUID NOT NULL,
  amount        BIGINT NOT NULL CHECK (amount > 0),
  currency      CHAR(3) NOT NULL,
  status        TEXT NOT NULL DEFAULT 'requested' CHECK (status IN (
    'requested', 'in_transit', 'paid', 'failed', 'indeterminate'
  )),
  reason        TEXT,
  failure_code  TEXT,
  provider      TEXT NOT NULL,
  provider_ref  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at   TIMESTAMPTZ,
  UNIQUE (id, tenant_id),
  -- Patrón AUD-P1-001: un payout jamás puede apuntar al merchant de otro tenant.
  CONSTRAINT payouts_merchant_coherence_fk
    FOREIGN KEY (merchant_id, tenant_id) REFERENCES merchants (id, tenant_id)
);

CREATE INDEX payouts_tenant_merchant_idx ON payouts (tenant_id, merchant_id);

CREATE TRIGGER payouts_no_delete
  BEFORE DELETE ON payouts
  FOR EACH ROW EXECUTE FUNCTION fluvia_forbid_mutation();
CREATE TRIGGER payouts_no_truncate
  BEFORE TRUNCATE ON payouts
  FOR EACH STATEMENT EXECUTE FUNCTION fluvia_forbid_mutation();

ALTER TABLE payouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE payouts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payouts
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON payouts TO fluvia_app;

-- ----------------------------------------------------------------------------
-- 2. Tabla de transiciones (referencia inmutable; fuente = mapa TS)
-- ----------------------------------------------------------------------------
CREATE TABLE payout_transitions (
  from_status TEXT NOT NULL,
  to_status   TEXT NOT NULL,
  PRIMARY KEY (from_status, to_status)
);

-- Seed GENERADO por @fluvia/payments-core scripts/gen-fsm-seed.ts — no editar
-- a mano (el meta-test compara la tabla contra el mapa TS PAYOUT_TRANSITIONS).
INSERT INTO payout_transitions (from_status, to_status) VALUES
  ('in_transit', 'failed'),
  ('in_transit', 'indeterminate'),
  ('in_transit', 'paid'),
  ('indeterminate', 'failed'),
  ('indeterminate', 'paid'),
  ('requested', 'failed'),
  ('requested', 'in_transit');

-- Inmutable: cambiar la FSM exige una migración nueva, jamás un UPDATE.
CREATE TRIGGER payout_transitions_no_update
  BEFORE UPDATE ON payout_transitions
  FOR EACH ROW EXECUTE FUNCTION fluvia_forbid_mutation();
CREATE TRIGGER payout_transitions_no_delete
  BEFORE DELETE ON payout_transitions
  FOR EACH ROW EXECUTE FUNCTION fluvia_forbid_mutation();
CREATE TRIGGER payout_transitions_no_truncate
  BEFORE TRUNCATE ON payout_transitions
  FOR EACH STATEMENT EXECUTE FUNCTION fluvia_forbid_mutation();

-- Solo lectura y SOLO para fluvia_app (el trigger corre con los privilegios
-- del invocador; fluvia_worker sigue siendo cascarón — ADR-0011).
GRANT SELECT ON payout_transitions TO fluvia_app;
REVOKE ALL ON payout_transitions FROM fluvia_worker, fluvia_relay, fluvia_inbox, fluvia_auth, fluvia_webhook;
REVOKE INSERT, UPDATE, DELETE ON payout_transitions FROM fluvia_app;

-- ----------------------------------------------------------------------------
-- 3. Trigger de validación (el MOTOR decide, no el servicio)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fluvia_validate_payout_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM payout_transitions
    WHERE from_status = OLD.status AND to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'FLUVIA_INVALID_TRANSITION: payout % -> % is not a legal transition',
      OLD.status, NEW.status
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER payouts_fsm_guard
  BEFORE UPDATE OF status ON payouts
  FOR EACH ROW EXECUTE FUNCTION fluvia_validate_payout_transition();
