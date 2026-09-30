-- ============================================================================
-- FLUVIA 0047_pos_sale_release_guard.sql  (POS — cierre de dos huecos de 0046)
--
-- 1. LIBERACIÓN LOCAL DE UNA VENTA DE COBRO ÚNICO. En 0046 una venta se libera
--    cuando su intent pasa a `failed` o `canceled`. Pero `authorized -> canceled`
--    (permitida por la FSM; la usa `POST /v1/payment_intents/:id/cancel`) es una
--    transición PURAMENTE LOCAL: no anula nada en el proveedor. Con fondos
--    retenidos, liberar la venta dejaría cobrar a otro checkout: el invariante
--    valdría en la BD y no frente al proveedor. Igual un `failed` escrito a mano
--    sobre un intent `processing` con desenlace incierto.
--
--    Regla del MOTOR (vale para el servicio, la ruta y un UPDATE directo con el
--    rol de la aplicación), SOLO para intents de ventas de cobro único
--    (`single_charge_link_id` no nulo; los links multiuso no cambian):
--      · estado que retiene la venta -> `canceled`: RECHAZADO. No existe todavía
--        anulación verificada del proveedor (el MockProvider no la expone);
--        cuando exista, deberá registrarse como hecho verificado y esta regla
--        se relajará para ese caso, no antes.
--      · estado que retiene la venta -> `failed`: solo con un rechazo RESUELTO
--        del proveedor para ese intent (attempt `failed`) y ningún attempt vivo
--        o cobrado (created/submitting/submitted/requires_action/indeterminate/
--        succeeded). Es lo que escribe `recordDeclined` en la MISMA transacción.
--    La FSM (mapa TS ↔ doc ↔ DDL) NO cambia: la restricción depende de la
--    política de la venta, no del estado, y los links multiuso conservan
--    `authorized -> canceled`.
--
-- 2. DERIVACIÓN QUE FALLABA ABIERTA. `fluvia_payment_intent_link_derive()`
--    buscaba el link con la RLS del invocador y, si no lo veía, dejaba
--    `single_charge_link_id` en NULL: ese intent escapaba del índice único y del
--    guard (reproducido con un invocador cuya RLS oculta el link). Ahora: si el
--    intent declara un link y el invocador no lo ve ⇒ ERROR (falla cerrado).
--    Además `search_path` fijado y nombres calificados (sin sombras por
--    search_path/pg_temp).
--
-- Datos existentes: ninguna fila se reescribe. `authorized` no es alcanzable
-- por ningún camino del código actual, así que ningún intent de venta de cobro
-- único pudo liberarse por esta vía antes de 0047.
-- ============================================================================

CREATE OR REPLACE FUNCTION fluvia_payment_intent_link_derive()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_single BOOLEAN;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.payment_link_id IS DISTINCT FROM OLD.payment_link_id
       OR NEW.single_charge_link_id IS DISTINCT FROM OLD.single_charge_link_id THEN
      RAISE EXCEPTION 'FLUVIA_IMMUTABLE: payment_intent link binding cannot change'
        USING ERRCODE = 'raise_exception';
    END IF;
    RETURN NEW;
  END IF;

  NEW.single_charge_link_id := NULL;
  IF NEW.payment_link_id IS NOT NULL THEN
    SELECT pl.single_charge INTO v_single
    FROM public.payment_links pl
    WHERE pl.id = NEW.payment_link_id AND pl.tenant_id = NEW.tenant_id;
    IF NOT FOUND THEN
      -- El invocador no ve el link que declara: no se puede saber su política.
      -- Fallar cerrado (jamás asumir «multiuso»).
      RAISE EXCEPTION 'FLUVIA_LINK_NOT_VISIBLE: payment_link % is not visible to the invoker; cannot derive its charge policy',
        NEW.payment_link_id
        USING ERRCODE = 'raise_exception';
    END IF;
    IF v_single THEN
      NEW.single_charge_link_id := NEW.payment_link_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION fluvia_payment_link_policy_immutable()
  SET search_path = pg_catalog, public, pg_temp;

CREATE OR REPLACE FUNCTION fluvia_single_charge_release_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.single_charge_link_id IS NULL OR NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  -- Solo importa salir de un estado que RETIENE la venta hacia uno que la
  -- libera (espejo del predicado de payment_intents_single_charge_uq).
  IF NEW.status NOT IN ('canceled', 'failed')
     OR OLD.status IN ('created', 'requires_payment_method', 'requires_confirmation', 'failed', 'canceled') THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'canceled' THEN
    RAISE EXCEPTION 'FLUVIA_SALE_RELEASE_UNVERIFIED: payment_intent % (%) of a single-charge sale cannot be canceled locally; a verified provider void is required',
      NEW.id, OLD.status
      USING ERRCODE = 'raise_exception';
  END IF;

  -- failed: exige un rechazo resuelto del proveedor y ningún attempt vivo/cobrado.
  IF NOT EXISTS (
       SELECT 1 FROM public.payment_attempts a
       WHERE a.intent_id = NEW.id AND a.status = 'failed'
     )
     OR EXISTS (
       SELECT 1 FROM public.payment_attempts a
       WHERE a.intent_id = NEW.id
         AND a.status IN ('created', 'submitting', 'submitted', 'requires_action', 'indeterminate', 'succeeded')
     ) THEN
    RAISE EXCEPTION 'FLUVIA_SALE_RELEASE_UNVERIFIED: payment_intent % (%) of a single-charge sale cannot fail without a resolved provider decline',
      NEW.id, OLD.status
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER payment_intents_single_charge_release_guard
  BEFORE UPDATE OF status ON payment_intents
  FOR EACH ROW EXECUTE FUNCTION fluvia_single_charge_release_guard();
