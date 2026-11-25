-- ============================================================================
-- FLUVIA 0070_merchant_risk_watchdog.sql  (seguimiento de #92 / #108 — alerta)
--
-- 0069 dejó a los comercios legados sin declaración de afiliación estatal como
-- `affiliation_declaration_status = 'pending_review'` SIN congelarlos (decisión
-- de producto, PR #108): siguen cobrando hasta que Legal decida caso por caso.
-- Eso solo es seguro si alguien VE la cola. Hoy depende de que un operador se
-- acuerde de correr `merchant-risk screen --include-undeclared`.
--
-- Esta función, igual que sweep_disputes (0038), NO transiciona nada: solo
-- SURFACEA conteos para gauges + alertas del worker. Congelar sigue siendo una
-- decisión del operador por el CLI auditado.
--
--   pending_review_active  comercios ACTIVOS sin declaración (pueden cobrar)
--   pending_review_total   ídem, incluidos los congelados (cola de Legal)
--   denylisted_active      comercios ACTIVOS cuyo nombre coincide HOY con un
--                          patrón activo de la lista. El guard de 0069 solo
--                          evalúa altas, renombrados y reactivaciones: un
--                          comercio legado, o uno anterior a un `denylist-add`,
--                          sigue activo sin que nada lo avise.
--
-- Misma familia de definers: SECURITY DEFINER sin parámetros (alcance imposible
-- de ensanchar), EXECUTE solo para fluvia_worker. El worker no lee `merchants`
-- cross-tenant ni la lista (0069 la revoca a todos los roles de runtime); el
-- definer cuenta por él y solo devuelve números, nunca nombres ni patrones.
-- ============================================================================

CREATE OR REPLACE FUNCTION sweep_merchant_risk()
RETURNS TABLE (metric TEXT, value BIGINT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n_pending_active BIGINT;
  n_pending_total BIGINT;
  n_denylisted_active BIGINT;
BEGIN
  -- Usa merchants_pending_review_idx (0069): state_affiliation IS NULL AND deleted_at IS NULL.
  SELECT count(*) FILTER (WHERE status = 'active'), count(*)
    INTO n_pending_active, n_pending_total
  FROM merchants
  WHERE state_affiliation IS NULL AND deleted_at IS NULL;

  SELECT count(*) INTO n_denylisted_active
  FROM merchants
  WHERE status = 'active' AND deleted_at IS NULL
    AND fluvia_merchant_name_denylisted(name);

  RETURN QUERY VALUES
    ('pending_review_active', n_pending_active),
    ('pending_review_total', n_pending_total),
    ('denylisted_active', n_denylisted_active);
END;
$$;

REVOKE ALL ON FUNCTION sweep_merchant_risk() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sweep_merchant_risk() TO fluvia_worker;
