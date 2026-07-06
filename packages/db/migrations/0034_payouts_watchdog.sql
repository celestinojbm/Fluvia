-- ============================================================================
-- FLUVIA 0034_payouts_watchdog.sql  (F4-07c — robustez del plano de payouts)
--
-- Espeja 0018 (attempts): un payout atascado en `in_transit` mas alla del lease
-- significa que el proceso murio ENTRE el emit (fondos ya en transito) y el
-- registro del desenlace del banco — el resultado es DESCONOCIDO por definicion,
-- y lo desconocido se llama `indeterminate` (V4 §23): jamas `failed` "porque
-- probablemente". Los fondos quedan RETENIDOS en payout.in_transit; la
-- resolucion sigue siendo SOLO por fuente verificada (webhook del banco /
-- consulta / conciliacion) via PayoutService.resolveFromProvider.
--
-- Salud del plano: conteos de indeterminados (totales y envejecidos) para el
-- gauge + alerta baseline, y de `requested` atascados (creados pero cuyo
-- `execute` nunca corrio — sin dinero en riesgo, el banco jamas fue contactado;
-- se SURFACEAN, no se re-ejecutan aqui para no arriesgar doble envio).
--
-- Misma familia que sweep_payment_attempts(): SECURITY DEFINER sin parametros
-- (alcance imposible de ensanchar), auditoria atomica cuando hay efecto,
-- EXECUTE solo para fluvia_worker.
--
-- Umbrales (Nivel C; cambiarlos = migracion nueva deliberada):
--   lease de in_transit / requested: 5 minutos  (la fase 2 tarda milisegundos)
--   indeterminado envejecido: 30 minutos
-- ============================================================================

CREATE INDEX payouts_in_transit_idx
  ON payouts (updated_at)
  WHERE status = 'in_transit';

CREATE INDEX payouts_indeterminate_idx
  ON payouts (updated_at)
  WHERE status = 'indeterminate';

CREATE INDEX payouts_requested_idx
  ON payouts (created_at)
  WHERE status = 'requested';

CREATE OR REPLACE FUNCTION sweep_payouts()
RETURNS TABLE (metric TEXT, value BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n_swept BIGINT;
  n_indeterminate BIGINT;
  n_aged BIGINT;
  n_requested_stuck BIGINT;
  swept_ids UUID[];
BEGIN
  WITH swept AS (
    -- Solo status + updated_at: `indeterminate` YA significa "desenlace
    -- desconocido". No se fija failure_code (no es un fallo, y al resolverse a
    -- `paid` quedaria un codigo espurio); el rastro vive en el audit_event.
    UPDATE payouts
    SET status = 'indeterminate',
        updated_at = now()
    WHERE status = 'in_transit'
      AND updated_at < now() - interval '5 minutes'
    RETURNING id
  )
  SELECT count(*), array_agg(id) INTO n_swept, swept_ids FROM swept;

  SELECT count(*) INTO n_indeterminate FROM payouts WHERE status = 'indeterminate';
  SELECT count(*) INTO n_aged
  FROM payouts
  WHERE status = 'indeterminate' AND updated_at < now() - interval '30 minutes';
  SELECT count(*) INTO n_requested_stuck
  FROM payouts
  WHERE status = 'requested' AND created_at < now() - interval '5 minutes';

  -- Auditoria EN la misma transaccion, solo cuando hubo efecto.
  IF n_swept > 0 THEN
    INSERT INTO audit_events
      (actor_type, auth_method, action, resource_type, risk_level, reason, after_summary)
    VALUES
      ('system', 'platform', 'payout.swept_indeterminate', 'payout', 'medium',
       'in_transit-lease sweep (F4-07c): bank outcome unknown, funds held in transit, awaiting verified resolution',
       jsonb_build_object('swept', n_swept, 'payout_ids', swept_ids));
  END IF;

  RETURN QUERY VALUES
    ('swept_to_indeterminate', n_swept),
    ('indeterminate_total', n_indeterminate),
    ('indeterminate_aged', n_aged),
    ('requested_stuck', n_requested_stuck);
END;
$$;

REVOKE ALL ON FUNCTION sweep_payouts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sweep_payouts() TO fluvia_worker;
