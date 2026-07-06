-- ============================================================================
-- FLUVIA 0031_reserve_reason.sql  (F4-05a — abstracción contable de reserves)
--
-- Añade `'reserve'` a las causas permitidas de `ledger_transactions.reason`. Un
-- hold/release de reserva es una RECLASIFICACIÓN entre dos pasivos del comercio
-- (`merchant.available ↔ merchant.reserve`): la obligación total con el comercio
-- no cambia, solo se aparta (riesgo/disputas) o se libera. Es su propia causa
-- (no `adjustment`/`transfer`) para que el origen contable sea preciso (V4: el
-- `reason` es causal).
--
-- NO depende de PEND-002 (pricing): el pricing solo bloquea el motor de FEES.
-- Idempotente (DROP IF EXISTS + ADD), como el patrón de 0007.
-- ============================================================================

ALTER TABLE ledger_transactions DROP CONSTRAINT IF EXISTS ledger_transactions_reason_check;
ALTER TABLE ledger_transactions ADD CONSTRAINT ledger_transactions_reason_check CHECK (
  reason IN (
    'payment', 'refund', 'fee', 'payout', 'transfer',
    'adjustment', 'settlement', 'reversal', 'reconciliation', 'reserve'
  )
);
