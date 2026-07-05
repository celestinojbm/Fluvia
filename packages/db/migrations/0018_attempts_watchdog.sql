-- ============================================================================
-- FLUVIA 0018_attempts_watchdog.sql  (F3-04 — robustez del plano de attempts)
--
-- 1. Barrido submitting -> indeterminate: un attempt atascado en `submitting`
--    mas alla del lease significa que el proceso murio ENTRE la fase 1 y el
--    registro del resultado — el desenlace es DESCONOCIDO por definicion, y
--    lo desconocido se llama `indeterminate` (V4 §23): jamas failed "porque
--    probablemente". La resolucion sigue siendo SOLO por fuente verificada
--    (webhook/consulta/conciliacion).
-- 2. Salud del plano: conteos de indeterminados (totales y envejecidos) para
--    el gauge + alerta baseline de observability.md.
--
-- Misma familia que purge_technical_data()/ledger_projection_drift():
-- SECURITY DEFINER sin parametros (alcance imposible de ensanchar), auditoria
-- atomica cuando hay efecto, EXECUTE solo para fluvia_worker.
--
-- Umbrales (Nivel C; cambiarlos = migracion nueva deliberada):
--   lease de submitting: 5 minutos    (fase 2 tarda milisegundos)
--   indeterminado envejecido: 30 minutos
-- ============================================================================

CREATE INDEX payment_attempts_submitting_idx
  ON payment_attempts (submitted_at)
  WHERE status = 'submitting';

CREATE INDEX payment_attempts_indeterminate_idx
  ON payment_attempts (updated_at)
  WHERE status = 'indeterminate';

CREATE OR REPLACE FUNCTION sweep_payment_attempts()
RETURNS TABLE (metric TEXT, value BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n_swept BIGINT;
  n_indeterminate BIGINT;
  n_aged BIGINT;
  swept_ids UUID[];
BEGIN
  WITH swept AS (
    UPDATE payment_attempts
    SET status = 'indeterminate',
        updated_at = now(),
        last_error = 'stuck in submitting past lease: process died mid-submission; outcome unknown (swept, V4 s23)'
    WHERE status = 'submitting'
      AND submitted_at < now() - interval '5 minutes'
    RETURNING id
  )
  SELECT count(*), array_agg(id) INTO n_swept, swept_ids FROM swept;

  SELECT count(*) INTO n_indeterminate FROM payment_attempts WHERE status = 'indeterminate';
  SELECT count(*) INTO n_aged
  FROM payment_attempts
  WHERE status = 'indeterminate' AND updated_at < now() - interval '30 minutes';

  -- Auditoria EN la misma transaccion, solo cuando hubo efecto.
  IF n_swept > 0 THEN
    INSERT INTO audit_events
      (actor_type, auth_method, action, resource_type, risk_level, reason, after_summary)
    VALUES
      ('system', 'platform', 'payment_attempt.swept_indeterminate', 'payment_attempt', 'medium',
       'submitting-lease sweep (F3-04): outcome unknown, awaiting verified resolution',
       jsonb_build_object('swept', n_swept, 'attempt_ids', swept_ids));
  END IF;

  RETURN QUERY VALUES
    ('swept_to_indeterminate', n_swept),
    ('indeterminate_total', n_indeterminate),
    ('indeterminate_aged', n_aged);
END;
$$;

REVOKE ALL ON FUNCTION sweep_payment_attempts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sweep_payment_attempts() TO fluvia_worker;
