-- ============================================================================
-- FLUVIA 0032_payout_accounts.sql  (F4-05b — abstracción contable de payout)
--
-- Completa el flujo de fondos "hacia afuera": el dinero capturado se convierte
-- en CAJA de Fluvia (platform.cash) y de ahí sale al comercio como PAYOUT:
--     merchant.available --(emit)--> payout.in_transit --(settle)--> platform.cash
--
-- Dos cambios de catálogo (el chart ejecutable vive en
-- packages/ledger/src/chart-of-accounts.ts; esto alinea las filas ya provistas):
--
-- 1. `payout.in_transit` pasa de ACTIVO (debit) a PASIVO (credit) — tratamiento
--    contable estándar de "payout en tránsito" (obligación en vuelo). La cuenta
--    era un PLACEHOLDER jamás usado (saldo 0 en toda fila); el cambio es seguro.
--    Guard duro: aborta si alguna fila tiene saldo no-cero.
--
-- 2. `platform.cash` (activo, caja/banco operativo) se aprovisiona para cada
--    (tenant, moneda) que ya tenga cuentas platform-scope. `ensureChart` la
--    añade además de forma aditiva para charts nuevos.
--
-- NO depende de PEND-002 (pricing): mover el dinero del comercio hacia afuera es
-- flujo de fondos, no fees. Idempotente.
-- ============================================================================

-- 1. payout.in_transit: activo -> pasivo (solo si está sin usar). El guard más
--    directo: cualquier asiento contra la cuenta haría que cambiar normal_side
--    invierta su signo — inseguro. Como la cuenta era placeholder, no hay ninguno.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM ledger_entries e
    JOIN ledger_accounts a ON a.id = e.account_id
    WHERE a.name = 'payout.in_transit'
  ) THEN
    RAISE EXCEPTION 'payout.in_transit tiene asientos; el cambio de normal_side no es seguro';
  END IF;
END $$;

UPDATE ledger_accounts
   SET normal_side = 'credit', updated_at = now()
 WHERE name = 'payout.in_transit'
   AND normal_side = 'debit';

-- 2. Backfill de platform.cash para charts platform-scope ya existentes
--    (provider.clearing es platform-scope y se provisiona con el chart).
INSERT INTO ledger_accounts (tenant_id, name, currency, normal_side)
SELECT DISTINCT tenant_id, 'platform.cash', currency, 'debit'
  FROM ledger_accounts
 WHERE name = 'provider.clearing'
ON CONFLICT (tenant_id, name, currency) DO NOTHING;

INSERT INTO balance_projections (account_id, tenant_id)
SELECT id, tenant_id FROM ledger_accounts WHERE name = 'platform.cash'
ON CONFLICT (account_id) DO NOTHING;
