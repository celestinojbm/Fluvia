-- ============================================================================
-- FLUVIA 0038_disputes_watchdog.sql  (F4-10 — salud del plano de disputas)
--
-- Espeja sweep_payouts (0034) PERO SIN barrido: una disputa `open`/`under_review`
-- retiene fondos del comercio en `dispute.reserve`, y su desenlace llega SOLO de
-- fuente verificada (el banco vía webhook — F4-08c), JAMÁS por timeout ni
-- asunción (V4 §23). Por eso esta función NO transiciona nada: solo SURFACEA la
-- salud para el gauge + alerta baseline. Una disputa envejecida (open más de N
-- días) exige intervención: asegurar que la evidencia se envió / perseguir la
-- resolución del banco antes de que venza el plazo (una disputa sin respuesta se
-- pierde por defecto).
--
-- Misma familia de definers: SECURITY DEFINER sin parámetros (alcance imposible
-- de ensanchar), EXECUTE solo para fluvia_worker (cascarón sin privilegios de
-- tabla — el rol worker no puede SELECT `disputes` bajo RLS; el definer cuenta
-- cross-tenant por él).
--
-- Umbral (Nivel C; cambiarlo = migración nueva deliberada):
--   envejecida = open/under_review con created_at > 7 días
--   (proxy del plazo de evidencia típico del banco).
-- ============================================================================

CREATE INDEX disputes_held_idx
  ON disputes (created_at)
  WHERE status IN ('open', 'under_review');

CREATE OR REPLACE FUNCTION sweep_disputes()
RETURNS TABLE (metric TEXT, value BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n_held BIGINT;
  n_aged BIGINT;
BEGIN
  -- Retenidas: disputas vivas (fondos apartados en dispute.reserve).
  SELECT count(*) INTO n_held
  FROM disputes
  WHERE status IN ('open', 'under_review');

  -- Envejecidas: vivas más allá del plazo — riesgo de pérdida por no responder.
  SELECT count(*) INTO n_aged
  FROM disputes
  WHERE status IN ('open', 'under_review')
    AND created_at < now() - interval '7 days';

  RETURN QUERY VALUES
    ('held_total', n_held),
    ('held_aged', n_aged);
END;
$$;

REVOKE ALL ON FUNCTION sweep_disputes() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sweep_disputes() TO fluvia_worker;
