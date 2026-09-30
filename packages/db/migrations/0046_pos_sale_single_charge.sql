-- ============================================================================
-- FLUVIA 0046_pos_sale_single_charge.sql  (POS — una venta, como máximo un cobro)
--
-- Hallazgo: una venta POS es un payment link; cada «abrir checkout» genera un
-- payment_intent + checkout_session NUEVOS (createSessionFromLink) y el confirm
-- alojado solo bloquea SU sesión. Dos checkouts de la misma venta podían
-- terminar ambos `succeeded` (reproducido con PG real). Nada relacionaba el
-- intent con su link (gap G3).
--
-- Esta migración (NO destructiva: solo añade columnas nulas/con default,
-- índices y triggers; no reescribe filas existentes):
--
--  1. payment_links.single_charge (default false): la política de cobro del
--     link. false = plantilla multiuso de siempre (links públicos intactos);
--     true = venta de cobro único (la crea el POS). Inmutable tras crearse.
--
--  2. payment_intents.payment_link_id: vínculo PERSISTENTE intent → link
--     (FK compuesta con tenant_id: jamás cruza tenant). NULL = intent directo o
--     registro ANTERIOR a esta migración (sin vínculo; no se infiere).
--     La cadena venta → sesiones es link → intents → checkout_sessions
--     (checkout_sessions.payment_intent_id ya existe).
--
--  3. payment_intents.single_charge_link_id: copia DERIVADA por trigger (el
--     caller no puede fijarla) = payment_link_id si el link es de cobro único.
--     Existe porque un índice parcial no puede mirar otra tabla.
--
--  4. EL INVARIANTE, en el motor: índice ÚNICO parcial sobre
--     single_charge_link_id para todo estado que ya cobró o puede estar
--     cobrando (todo salvo created/requires_*/failed/canceled). Dos intents de
--     la misma venta no pueden estar a la vez en processing/succeeded/...: el
--     segundo UPDATE a `processing` espera al primero y falla con 23505 si este
--     confirma. Un desenlace INCIERTO del proveedor deja el intent en
--     `processing` (attempt indeterminate/submitted) y por tanto RETIENE la
--     venta hasta una resolución verificada; solo failed/canceled la liberan.
--     Un intent reembolsado sigue reteniéndola (la venta ya se cobró una vez).
--
-- Los intents anteriores tienen single_charge_link_id NULL: el índice no los
-- cubre (sus ventas no tenían política; se documenta como límite).
-- ============================================================================

ALTER TABLE payment_links
  ADD COLUMN single_charge BOOLEAN NOT NULL DEFAULT false,
  -- Desde cuándo el servidor registra los checkouts de este link. `now()` es
  -- STABLE: las filas EXISTENTES toman el instante de esta migración (sin
  -- reescribir la tabla) y las nuevas su propio instante de creación. Un link
  -- con created_at < checkout_tracking_since tiene checkouts anteriores SIN
  -- vínculo: su historial por venta es PARCIAL y así se declara.
  ADD COLUMN checkout_tracking_since TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE payment_intents
  ADD COLUMN payment_link_id UUID,
  ADD COLUMN single_charge_link_id UUID,
  ADD CONSTRAINT payment_intents_link_coherence_fk
    FOREIGN KEY (payment_link_id, tenant_id) REFERENCES payment_links (id, tenant_id),
  ADD CONSTRAINT payment_intents_single_charge_link_chk
    CHECK (single_charge_link_id IS NULL OR single_charge_link_id = payment_link_id);

CREATE INDEX payment_intents_link_idx ON payment_intents (payment_link_id, created_at)
  WHERE payment_link_id IS NOT NULL;

CREATE UNIQUE INDEX payment_intents_single_charge_uq ON payment_intents (single_charge_link_id)
  WHERE single_charge_link_id IS NOT NULL
    AND status NOT IN (
      'created', 'requires_payment_method', 'requires_confirmation', 'failed', 'canceled'
    );

-- ----------------------------------------------------------------------------
-- Derivación e inmutabilidad (el MOTOR decide, no el servicio)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fluvia_payment_intent_link_derive()
RETURNS trigger
LANGUAGE plpgsql
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
    -- Mismo tenant (RLS del invocador + FK compuesta): el link es visible.
    SELECT pl.single_charge INTO v_single
    FROM payment_links pl
    WHERE pl.id = NEW.payment_link_id AND pl.tenant_id = NEW.tenant_id;
    IF v_single THEN
      NEW.single_charge_link_id := NEW.payment_link_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER payment_intents_link_derive
  BEFORE INSERT ON payment_intents
  FOR EACH ROW EXECUTE FUNCTION fluvia_payment_intent_link_derive();
CREATE TRIGGER payment_intents_link_immutable
  BEFORE UPDATE OF payment_link_id, single_charge_link_id ON payment_intents
  FOR EACH ROW EXECUTE FUNCTION fluvia_payment_intent_link_derive();

CREATE OR REPLACE FUNCTION fluvia_payment_link_policy_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.single_charge IS DISTINCT FROM OLD.single_charge THEN
    RAISE EXCEPTION 'FLUVIA_IMMUTABLE: payment_link single_charge cannot change'
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER payment_links_policy_immutable
  BEFORE UPDATE OF single_charge ON payment_links
  FOR EACH ROW EXECUTE FUNCTION fluvia_payment_link_policy_immutable();
