-- ============================================================================
-- FLUVIA 0011_projection_drift.sql  (F2-05 — deteccion programada de drift)
--
-- ledger_projection_drift(): compara TODA fila de proyeccion EXISTENTE contra
-- el recomputo desde ledger_entries (misma semantica que verifyProjection:
-- delta = amount si direction == normal_side, si no -amount; por bucket).
-- Una cuenta SIN fila de proyeccion no es corrupcion silenciosa: es estado
-- no materializado — getBalance la reporta como inexistente (fallo visible)
-- y rebuildProjection la materializa. El drift silencioso que este check
-- caza es una fila viva que MIENTE sobre el ledger.
--
-- SECURITY DEFINER: es una ventana de SOLO LECTURA cross-tenant, acotada y
-- auditable (mismo patron que authenticate_api_key). Se otorga UNICAMENTE a
-- fluvia_worker (el proceso que la ejecuta de forma programada); el rol app
-- sigue tenant-scoped y usa verifyProjection/rebuildProjection por cuenta.
-- ============================================================================

CREATE FUNCTION ledger_projection_drift()
RETURNS TABLE (
  account_id UUID,
  tenant_id UUID,
  projected_available BIGINT,
  projected_pending BIGINT,
  recomputed_available BIGINT,
  recomputed_pending BIGINT
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
        ELSE 0 END), 0)::bigint AS available,
      COALESCE(SUM(CASE WHEN e.bucket = 'pending'
        THEN CASE WHEN e.direction = a.normal_side THEN e.amount ELSE -e.amount END
        ELSE 0 END), 0)::bigint AS pending
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
