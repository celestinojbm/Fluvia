-- ============================================================================
-- FLUVIA 0026_webhook_event_resend.sql  (F3-09a — reenvío manual auditado de
-- eventos de webhook `dead`)
--
-- El deliverer (0019) mueve un evento a `dead` tras agotar el calendario de
-- reintentos. El comercio necesita poder REENVIAR ese evento desde el panel de
-- operación (diferido de F3-07). Reenviar NO resucita el evento muerto (clase
-- append-only, estado terminal inmutable): genera un evento FRESCO que clona
-- (tenant, endpoint, topic, payload) y entra por el ciclo normal del deliverer
-- (attempts=0, next_attempt_at=now()), enlazado al muerto vía
-- `resent_from_event_id` para trazabilidad.
--
-- `fluvia_app` tiene SELECT sobre webhook_events/webhook_attempts (privilegios
-- por defecto de 0002) pero NO INSERT/UPDATE (revocados en 0019 — la cola la
-- escribe el relay). El reenvío va por una función SECURITY DEFINER acotada
-- (ventana ADR-0011): solo clona eventos `dead` del propio tenant.
-- ============================================================================

ALTER TABLE webhook_events
  ADD COLUMN resent_from_event_id UUID REFERENCES webhook_events(id);

CREATE INDEX webhook_events_resent_from_idx ON webhook_events (resent_from_event_id)
  WHERE resent_from_event_id IS NOT NULL;

-- El relay solo inserta (tenant_id, endpoint_id, topic, payload); el reenvío
-- añade resent_from_event_id, así que va por la función definer, no por el
-- grant de inserción del relay.

-- ----------------------------------------------------------------------------
-- Reenvío acotado: clona un evento `dead` del tenant como evento `pending`
-- fresco. Devuelve el id del evento nuevo, o NULL si no hay un `dead` que
-- coincida (inexistente, ajeno, o no-muerto — el llamador traduce a not-found).
-- ----------------------------------------------------------------------------
CREATE FUNCTION webhook_event_resend(p_event_id UUID, p_tenant_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_id UUID;
BEGIN
  INSERT INTO webhook_events (tenant_id, endpoint_id, topic, payload, resent_from_event_id)
  SELECT e.tenant_id, e.endpoint_id, e.topic, e.payload, e.id
  FROM webhook_events e
  WHERE e.id = p_event_id
    AND e.tenant_id = p_tenant_id
    AND e.status = 'dead'
  RETURNING id INTO v_new_id;

  RETURN v_new_id;  -- NULL si el SELECT no encontró un `dead` del tenant.
END;
$$;

REVOKE ALL ON FUNCTION webhook_event_resend(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION webhook_event_resend(UUID, UUID) TO fluvia_app;
