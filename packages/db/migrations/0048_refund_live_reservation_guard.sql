-- ============================================================================
-- FLUVIA 0048_refund_live_reservation_guard.sql  (refunds — cupo vivo en el motor)
--
-- HUECO (reproducido contra PG real): el remanente reembolsable de un cobro se
-- calculaba en el servicio como `capturado − aplicado − refunds en
-- created/processing`. Un refund `indeterminate` (el proveedor pudo haberlo
-- ejecutado; su reserva contable sigue RETENIDA) no contaba: su cupo volvía a
-- quedar libre. Una segunda solicitud sobre el mismo cobro —desde el POS o por
-- la API directa— nacía en `created` y la única barrera restante era el guard
-- de no-negatividad del ledger sobre `merchant.available`. Con saldo de OTROS
-- cobros del mismo comercio, la segunda devolución reservaba y liquidaba: dos
-- devoluciones vivas por el total de un cobro, y la confirmación verificada de
-- la primera quedaba bloqueada para siempre por el CHECK
-- `payment_intents_refunded_le_captured` (reserva retenida sin salida).
--
-- REGLA DEL MOTOR (vale para el servicio, cualquier ruta y un INSERT directo
-- con el rol de la aplicación):
--
--   Σ refunds VIVOS (created | processing | indeterminate) del intent
--     ≤ amount_captured − amount_refunded
--
-- evaluada al insertar, BAJO el lock de la fila del intent (FOR UPDATE): dos
-- inserciones concurrentes sobre el mismo cobro se serializan en esa fila, así
-- que la segunda ve la primera ya confirmada. `settle` mueve el importe de
-- «vivo» a `amount_refunded` en la MISMA transacción (onPosted), por lo que la
-- suma no cambia al liquidar; `failed`/`canceled` devuelven cupo.
--
-- Además, `amount` y `payment_intent_id` de un refund son INMUTABLES (el cupo
-- no puede burlarse insertando poco y actualizando después).
--
-- La FSM de refunds (0020) NO cambia. Datos existentes: ninguna fila se
-- reescribe (la regla solo actúa en INSERT/UPDATE nuevos).
-- ============================================================================

CREATE OR REPLACE FUNCTION fluvia_refund_live_reservation_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_captured BIGINT;
  v_refunded BIGINT;
  v_live     BIGINT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.amount IS DISTINCT FROM OLD.amount
       OR NEW.payment_intent_id IS DISTINCT FROM OLD.payment_intent_id THEN
      RAISE EXCEPTION 'FLUVIA_REFUND_IMMUTABLE: refund % amount/payment_intent_id cannot change',
        OLD.id
        USING ERRCODE = 'raise_exception';
    END IF;
    RETURN NEW;
  END IF;

  -- Lock de la fila del cobro: serializa toda reserva de cupo sobre él.
  SELECT amount_captured, amount_refunded
    INTO v_captured, v_refunded
    FROM public.payment_intents
   WHERE id = NEW.payment_intent_id AND tenant_id = NEW.tenant_id
     FOR UPDATE;
  IF NOT FOUND THEN
    -- Falla cerrado: sin ver el cobro no se reserva nada.
    RAISE EXCEPTION 'FLUVIA_REFUND_EXCEEDS_REMAINING: payment intent % not visible',
      NEW.payment_intent_id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT COALESCE(SUM(r.amount), 0)
    INTO v_live
    FROM public.refunds r
   WHERE r.payment_intent_id = NEW.payment_intent_id
     AND r.tenant_id = NEW.tenant_id
     AND r.status IN ('created', 'processing', 'indeterminate');

  IF v_live + NEW.amount > v_captured - v_refunded THEN
    RAISE EXCEPTION 'FLUVIA_REFUND_EXCEEDS_REMAINING: requested % exceeds remaining % (captured %, refunded %, live %)',
      NEW.amount, GREATEST(v_captured - v_refunded - v_live, 0), v_captured, v_refunded, v_live
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER refunds_live_reservation_guard
  BEFORE INSERT OR UPDATE OF amount, payment_intent_id ON refunds
  FOR EACH ROW EXECUTE FUNCTION fluvia_refund_live_reservation_guard();
