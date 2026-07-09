-- ============================================================================
-- FLUVIA 0039_projection_drift_numeric.sql
--   (V2-R4, re-auditoría v2 — completar la robustez de overflow en el detector
--    de drift en TIEMPO DE EJECUCIÓN)
--
-- V2-R4 endureció el recomputo del ledger para que NUNCA aborte por un cast
-- intermedio a bigint en el borde del rango: `SUM(bigint)` en PG ya es `numeric`
-- (sin overflow silencioso), pero un `::bigint` explícito sobre una suma que se
-- pase de rango lanzaría "bigint out of range". Ese endurecimiento se aplicó a
-- `verifyProjection`/`rebuildProjection` (bajo demanda, por cuenta) y a
-- `scripts/verify-ledger-invariants.sql` (auditoría externa), PERO NO a
-- `ledger_projection_drift()` (0011) — que es el detector CONTINUO que corre el
-- worker (DriftWatcher) cada intervalo.
--
-- Ahí el riesgo es MAYOR: un `::bigint` que aborte no falla una cuenta, aborta
-- TODA la corrida del check y ciega al watchdog frente al drift de CUALQUIER
-- cuenta — justo el estado en que más se necesita ver la verdad. Se recomputa en
-- `numeric` y se devuelve `numeric` (las columnas RECOMPUTED); las columnas
-- PROJECTED siguen `bigint` (vienen de balance_projections, que es bigint y no
-- puede sobrepasar su propio rango). La comparación `bigint <> numeric` es por
-- valor (exacta). Cambiar el tipo de retorno exige DROP + CREATE (CREATE OR
-- REPLACE no permite cambiar la firma de salida). El consumidor (drift.ts) ya
-- lee las columnas vía `::text`, así que `numeric::text` == `bigint::text` para
-- todo entero en rango: no requiere cambio de código.
-- ============================================================================

DROP FUNCTION IF EXISTS ledger_projection_drift();

CREATE FUNCTION ledger_projection_drift()
RETURNS TABLE (
  account_id UUID,
  tenant_id UUID,
  projected_available BIGINT,
  projected_pending BIGINT,
  recomputed_available NUMERIC,
  recomputed_pending NUMERIC
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH recomputed AS (
    SELECT e.account_id,
      COALESCE(SUM(CASE WHEN e.bucket = 'available'
        THEN CASE WHEN e.direction = a.normal_side THEN e.amount ELSE -e.amount END
        ELSE 0 END), 0)::numeric AS available,
      COALESCE(SUM(CASE WHEN e.bucket = 'pending'
        THEN CASE WHEN e.direction = a.normal_side THEN e.amount ELSE -e.amount END
        ELSE 0 END), 0)::numeric AS pending
    FROM ledger_entries e
    JOIN ledger_accounts a ON a.id = e.account_id
    GROUP BY e.account_id
  )
  SELECT p.account_id, p.tenant_id, p.available, p.pending,
         COALESCE(r.available, 0), COALESCE(r.pending, 0)
  FROM balance_projections p
  LEFT JOIN recomputed r ON r.account_id = p.account_id
  WHERE p.available <> COALESCE(r.available, 0)
     OR p.pending <> COALESCE(r.pending, 0)
$$;

REVOKE ALL ON FUNCTION ledger_projection_drift() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ledger_projection_drift() TO fluvia_worker;
