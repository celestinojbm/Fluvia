-- ============================================================================
-- FLUVIA 0053_program_maintenance.sql  (jornada integral — mantenimiento)
--
-- El worker resuelve de forma periódica lo que, sin él, solo resolvería un
-- operador: retiros inciertos (consulta al proveedor), eventos sin objeto
-- (reintento controlado), autorizaciones vencidas (liberación de reservas),
-- cuotas vencidas (marcado con fecha de corte) y cobros/devoluciones inciertos
-- del lado comercio (consulta verificable).
--
-- El rol fluvia_worker NO tiene privilegios de tabla (ADR-0011). Estas
-- funciones SECURITY DEFINER le devuelven SOLO identificadores de tenant con
-- trabajo pendiente; el trabajo en sí lo hace el rol de la app con contexto de
-- tenant (RLS), como el resto de motores por tenant.
-- ============================================================================

CREATE OR REPLACE FUNCTION list_program_tenants()
RETURNS TABLE (tenant_id UUID)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT tenant_id FROM consumer_programs ORDER BY created_at;
$$;

CREATE OR REPLACE FUNCTION list_tenants_with_uncertain_payments(p_min_age_seconds INT)
RETURNS TABLE (tenant_id UUID)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT tenant_id FROM payment_attempts
   WHERE status = 'indeterminate'
     AND updated_at < now() - make_interval(secs => p_min_age_seconds)
  UNION
  SELECT DISTINCT tenant_id FROM refunds
   WHERE status IN ('processing', 'indeterminate')
     AND updated_at < now() - make_interval(secs => p_min_age_seconds);
$$;

REVOKE ALL ON FUNCTION list_program_tenants() FROM PUBLIC;
REVOKE ALL ON FUNCTION list_tenants_with_uncertain_payments(INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_program_tenants() TO fluvia_worker;
GRANT EXECUTE ON FUNCTION list_tenants_with_uncertain_payments(INT) TO fluvia_worker;
