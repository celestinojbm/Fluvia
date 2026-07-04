-- ============================================================================
-- FLUVIA 0007_ledger_core.sql  (F2-01 + F2-02)
--
-- Modelo definitivo del nucleo contable:
--   1. Enlace causal y de reversion en ledger_transactions.
--   2. balance_projections separada de la definicion de cuenta (el derivado
--      no vive junto a la fuente; reconstruible desde ledger_entries).
--   3. INVARIANTES A NIVEL DE MOTOR (V4 §17.2, Gate Ledger):
--      - Toda transaccion contable balancea por (tx, moneda) al COMMIT.
--      - No existen cabeceras de transaccion sin asientos.
--      Constraint triggers DEFERRABLE INITIALLY DEFERRED: ningun cliente
--      (servicio, ORM, SQL manual, superusuario) puede confirmar un asiento
--      desbalanceado. Prohibido compensar entre monedas por construccion.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Enlace causal + reversion
-- ----------------------------------------------------------------------------
ALTER TABLE ledger_transactions
  ADD COLUMN source_type TEXT,
  ADD COLUMN source_id TEXT,
  ADD COLUMN reverses_tx_id UUID REFERENCES ledger_transactions(id);

ALTER TABLE ledger_transactions DROP CONSTRAINT ledger_transactions_reason_check;
ALTER TABLE ledger_transactions ADD CONSTRAINT ledger_transactions_reason_check CHECK (
  reason IN (
    'payment', 'refund', 'fee', 'payout', 'transfer',
    'adjustment', 'settlement', 'reversal', 'reconciliation'
  )
);

CREATE INDEX ledger_transactions_source_idx
  ON ledger_transactions (source_type, source_id);
CREATE INDEX ledger_transactions_reverses_idx
  ON ledger_transactions (reverses_tx_id)
  WHERE reverses_tx_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 2. balance_projections (rollup versionado, reconstruible; NUNCA fuente)
-- ----------------------------------------------------------------------------
CREATE TABLE balance_projections (
  account_id  UUID PRIMARY KEY REFERENCES ledger_accounts(id),
  tenant_id   UUID NOT NULL REFERENCES organizations(id),
  available   BIGINT NOT NULL DEFAULT 0,
  pending     BIGINT NOT NULL DEFAULT 0,
  version     BIGINT NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX balance_projections_tenant_idx ON balance_projections (tenant_id);

-- Backfill desde el cache del spike y contraccion de ledger_accounts:
-- la cuenta queda como pura definicion (sin estado derivado).
INSERT INTO balance_projections (account_id, tenant_id, available, pending, version)
SELECT id, tenant_id, balance_available, balance_pending, sequence_version
FROM ledger_accounts;

ALTER TABLE ledger_accounts
  DROP COLUMN balance_available,
  DROP COLUMN balance_pending,
  DROP COLUMN sequence_version;

CREATE TRIGGER balance_projections_no_delete
  BEFORE DELETE ON balance_projections
  FOR EACH ROW EXECUTE FUNCTION fluvia_forbid_mutation();
CREATE TRIGGER balance_projections_no_truncate
  BEFORE TRUNCATE ON balance_projections
  FOR EACH STATEMENT EXECUTE FUNCTION fluvia_forbid_mutation();

ALTER TABLE balance_projections ENABLE ROW LEVEL SECURITY;
ALTER TABLE balance_projections FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON balance_projections
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ----------------------------------------------------------------------------
-- 3. Invariantes diferidas del ledger
-- ----------------------------------------------------------------------------

-- 3a. Balanceo por (transaccion, moneda) verificado al COMMIT.
CREATE FUNCTION ledger_assert_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  bad RECORD;
BEGIN
  SELECT e.currency,
         SUM(CASE WHEN e.direction = 'debit' THEN e.amount ELSE 0 END)  AS debits,
         SUM(CASE WHEN e.direction = 'credit' THEN e.amount ELSE 0 END) AS credits
  INTO bad
  FROM ledger_entries e
  WHERE e.tx_root_id = NEW.tx_root_id
  GROUP BY e.currency
  HAVING SUM(CASE WHEN e.direction = 'debit' THEN e.amount ELSE -e.amount END) <> 0
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'FLUVIA_UNBALANCED: ledger transaction % does not balance in % (debits=%, credits=%)',
      NEW.tx_root_id, bad.currency, bad.debits, bad.credits;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER ledger_entries_balanced
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_assert_balanced();

-- 3b. Sin cabeceras huerfanas: toda transaccion tiene asientos al COMMIT.
CREATE FUNCTION ledger_assert_nonempty() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM ledger_entries e WHERE e.tx_root_id = NEW.id) THEN
    RAISE EXCEPTION
      'FLUVIA_EMPTY_TRANSACTION: ledger transaction % has no entries at commit', NEW.id;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER ledger_transactions_nonempty
  AFTER INSERT ON ledger_transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_assert_nonempty();
