-- ============================================================================
-- FLUVIA 0028_reconciliation_sweep.sql  (F4-02 — conciliación batch/continua)
--
-- Lleva la conciliación de "a demanda" (F4-01b, `reconcile()` per-tenant bajo
-- RLS) a "continua": un barrido cross-tenant que concilia automáticamente los
-- reportes cuyo PERIODO YA CERRÓ (`open` + `period_end <= now()`). Ese es el
-- disparador natural de "reporte sellado" — mientras el periodo sigue abierto
-- llegan líneas y liquidaciones, conciliar antes sería prematuro.
--
-- Misma familia que sweep_payment_attempts()/sweep_checkout_sessions(): SECURITY
-- DEFINER sin parámetros (alcance imposible de ensanchar), EXECUTE solo para
-- fluvia_worker (que no tiene privilegios de tabla). Idempotente con la
-- conciliación manual: ambas transicionan bajo el guard `status='open'`, y la
-- conciliación manual deja el reporte `reconciled` (fuera del barrido).
--
-- La clasificación es IDÉNTICA a ReconciliationService.reconcile (FULL OUTER
-- JOIN líneas del proveedor ⋈ intentos `succeeded` del ledger), replicada aquí
-- de forma set-based sobre todos los reportes vencidos. `FOR UPDATE SKIP LOCKED`
-- da el lease: dos barridos concurrentes jamás tocan el mismo reporte (la
-- UNIQUE de reconciliation_entries lo garantizaría, pero el skip lo evita antes).
-- ============================================================================

CREATE OR REPLACE FUNCTION sweep_settlement_reports()
RETURNS TABLE (metric TEXT, value BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n_reports BIGINT;
  n_matched BIGINT;
  n_amount_mismatch BIGINT;
  n_missing_in_ledger BIGINT;
  n_missing_at_provider BIGINT;
BEGIN
  WITH due AS (
    -- Reportes sellados listos para conciliar. El lease evita doble proceso.
    SELECT id, tenant_id, provider, currency, period_start, period_end
    FROM settlement_reports
    WHERE status = 'open' AND period_end <= now()
    ORDER BY period_end
    FOR UPDATE SKIP LOCKED
  ),
  lines AS (
    SELECT sl.report_id, sl.provider_ref, sl.amount
    FROM settlement_lines sl
    JOIN due d ON d.id = sl.report_id
  ),
  ledger AS (
    -- Lo que Fluvia CREE liquidado: intentos succeeded con provider_ref dentro
    -- del periodo, mismo proveedor/moneda (idéntico al motor per-tenant).
    SELECT d.id AS report_id, pa.provider_ref, pa.amount, pa.intent_id
    FROM due d
    JOIN payment_attempts pa
      ON pa.tenant_id = d.tenant_id
     AND pa.provider = d.provider
     AND pa.currency = d.currency
     AND pa.status = 'succeeded'
     AND pa.provider_ref IS NOT NULL
     AND pa.resolved_at >= d.period_start
     AND pa.resolved_at < d.period_end
  ),
  classified AS (
    INSERT INTO reconciliation_entries
      (report_id, tenant_id, provider, provider_ref, status,
       ledger_amount, provider_amount, payment_intent_id)
    SELECT
      d.id, d.tenant_id, d.provider,
      COALESCE(l.provider_ref, g.provider_ref),
      CASE
        WHEN g.provider_ref IS NULL THEN 'missing_in_ledger'
        WHEN l.provider_ref IS NULL THEN 'missing_at_provider'
        WHEN g.amount = l.amount THEN 'matched'
        ELSE 'amount_mismatch'
      END,
      g.amount, l.amount, g.intent_id
    FROM lines l
    FULL OUTER JOIN ledger g
      ON g.report_id = l.report_id AND g.provider_ref = l.provider_ref
    JOIN due d ON d.id = COALESCE(l.report_id, g.report_id)
    RETURNING status
  ),
  marked AS (
    -- TODOS los reportes vencidos quedan `reconciled`, incluso los vacíos
    -- (sin líneas ni ledger): una corrida sin discrepancias también cierra.
    UPDATE settlement_reports
    SET status = 'reconciled', reconciled_at = now()
    WHERE id IN (SELECT id FROM due)
    RETURNING id
  )
  SELECT
    (SELECT count(*) FROM marked),
    (SELECT count(*) FROM classified WHERE status = 'matched'),
    (SELECT count(*) FROM classified WHERE status = 'amount_mismatch'),
    (SELECT count(*) FROM classified WHERE status = 'missing_in_ledger'),
    (SELECT count(*) FROM classified WHERE status = 'missing_at_provider')
  INTO n_reports, n_matched, n_amount_mismatch, n_missing_in_ledger, n_missing_at_provider;

  RETURN QUERY VALUES
    ('reports_reconciled', n_reports),
    ('matched', n_matched),
    ('amount_mismatch', n_amount_mismatch),
    ('missing_in_ledger', n_missing_in_ledger),
    ('missing_at_provider', n_missing_at_provider);
END;
$$;

REVOKE ALL ON FUNCTION sweep_settlement_reports() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sweep_settlement_reports() TO fluvia_worker;
