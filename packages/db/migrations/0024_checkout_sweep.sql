-- ============================================================================
-- FLUVIA 0024_checkout_sweep.sql  (F3-05c-ii — entrega garantizada)
--
-- Barrido de sesiones de checkout: cierra el hueco de depender del polling del
-- comprador (F3-05c-i). Misma familia que sweep_payment_attempts()/purge/drift:
-- SECURITY DEFINER sin parámetros (alcance imposible de ensanchar), EXECUTE solo
-- para fluvia_worker.
--
--   open + intent succeeded  -> completed  (+ checkout_session.completed)
--   open + TTL vencido        -> expired    (+ checkout_session.expired)
--
-- Un intent con éxito GANA sobre un TTL vencido (coherente con getByClientSecret).
-- Los eventos entran al outbox con el sobre común (@fluvia/events): el relay los
-- valida antes de despachar, así que se construyen EXACTOS aquí. Las dos ramas
-- son disjuntas (una fila jamás la tocan ambos UPDATE del mismo WITH).
-- ============================================================================

CREATE OR REPLACE FUNCTION sweep_checkout_sessions()
RETURNS TABLE (metric TEXT, value BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n_completed BIGINT;
  n_expired BIGINT;
BEGIN
  WITH completed AS (
    UPDATE checkout_sessions cs
    SET status = 'completed', completed_at = now(), updated_at = now()
    FROM payment_intents i
    WHERE cs.payment_intent_id = i.id
      AND cs.status = 'open'
      AND i.status = 'succeeded'
    RETURNING cs.id, cs.tenant_id, cs.payment_intent_id
  ),
  expired AS (
    UPDATE checkout_sessions cs
    SET status = 'expired', updated_at = now()
    FROM payment_intents i
    WHERE cs.payment_intent_id = i.id
      AND cs.status = 'open'
      AND cs.expires_at <= now()
      AND i.status <> 'succeeded' -- succeeded ya lo captura la rama `completed` (ramas disjuntas)
    RETURNING cs.id, cs.tenant_id, cs.payment_intent_id
  ),
  emitted AS (
    INSERT INTO outbox_events (tenant_id, topic, payload)
    SELECT c.tenant_id, 'checkout_session.completed',
      jsonb_build_object(
        'event_id', 'evt_' || gen_random_uuid()::text,
        'schema_version', 1,
        'occurred_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'producer', 'fluvia.payments',
        'resource', jsonb_build_object('type', 'checkout_session', 'id', c.id::text),
        'data', jsonb_build_object(
          'checkout_session_id', c.id::text,
          'payment_intent_id', c.payment_intent_id::text,
          'status', 'completed'
        )
      )
    FROM completed c
    UNION ALL
    SELECT e.tenant_id, 'checkout_session.expired',
      jsonb_build_object(
        'event_id', 'evt_' || gen_random_uuid()::text,
        'schema_version', 1,
        'occurred_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'producer', 'fluvia.payments',
        'resource', jsonb_build_object('type', 'checkout_session', 'id', e.id::text),
        'data', jsonb_build_object(
          'checkout_session_id', e.id::text,
          'payment_intent_id', e.payment_intent_id::text,
          'status', 'expired'
        )
      )
    FROM expired e
    RETURNING 1
  )
  SELECT
    (SELECT count(*) FROM completed),
    (SELECT count(*) FROM expired)
  INTO n_completed, n_expired;

  RETURN QUERY VALUES
    ('completed', n_completed),
    ('expired', n_expired);
END;
$$;

REVOKE ALL ON FUNCTION sweep_checkout_sessions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sweep_checkout_sessions() TO fluvia_worker;
