-- ============================================================================
-- FLUVIA 0012_reversal_uniqueness.sql  (F2-07 — compensaciones via servicio)
--
-- Invariante de MOTOR: una transaccion del ledger puede ser revertida A LO
-- SUMO una vez. Dos reversiones de la misma tx duplicarian el efecto neto
-- contrario; la carrera entre dos reversals concurrentes la decide este
-- indice unico, no el codigo de aplicacion.
-- ============================================================================

DO $$
DECLARE
  bad INT;
BEGIN
  SELECT count(*) INTO bad FROM (
    SELECT reverses_tx_id FROM ledger_transactions
    WHERE reverses_tx_id IS NOT NULL
    GROUP BY reverses_tx_id HAVING count(*) > 1
  ) dup;
  IF bad > 0 THEN
    RAISE EXCEPTION
      'FLUVIA_MIGRATION_BLOCKED: % transactions have multiple reversals', bad;
  END IF;
END;
$$;

CREATE UNIQUE INDEX ledger_transactions_reverses_once
  ON ledger_transactions (reverses_tx_id)
  WHERE reverses_tx_id IS NOT NULL;
