-- ============================================================================
-- FLUVIA 0051_commerce_inventory_variants.sql  (Plataforma del comercio — sandbox)
--
-- Aditiva: solo columnas nulas/con default, tablas nuevas, índices y triggers.
-- No reescribe filas, no toca ledger, importes, FSM de pagos ni reglas
-- monetarias. Ventas históricas intactas.
--
--  1. catalog_products:
--     - image_ref: imagen de un CONJUNTO CERRADO de archivos propios servidos
--       por el dashboard/checkout (`catalog/<nombre>.jpg`). La CSP de ambas
--       apps es `img-src 'self'`: una URL externa no se mostraría y filtraría
--       el referer. Subir imágenes requiere almacenamiento: no autorizado.
--     - variant_of / variant_label: variantes MÍNIMAS de un nivel. Una
--       variante es un producto completo (su SKU, precio, existencias) que
--       apunta a su producto base. Se fija al crear y no cambia (sin carreras
--       que conviertan una base en variante). Misma moneda que la base.
--     - track_stock: el comercio decide qué productos cuentan existencias.
--
--  2. Existencias (inventory_levels + inventory_movements):
--     - Los movimientos son APPEND-ONLY; el nivel es una proyección que SOLO
--       mantiene el motor (trigger SECURITY DEFINER; la app no puede escribir
--       niveles). on_hand ≥ reserved ≥ 0 en el motor.
--     - reservation (+reservado) al registrar la venta, en su MISMA tx.
--     - sale (−existencia, −reservado) SOLO cuando un cobro del link de la
--       venta llega a `succeeded` (trigger en payment_intents). Un intento
--       rechazado NO libera (la venta sigue abierta y se puede reintentar); un
--       resultado INCIERTO (processing/requires_action) retiene la reserva.
--     - release (−reservado) SOLO al ANULAR la venta (punto 3).
--     - receipt / adjustment: entradas y correcciones del comercio, con motivo.
--     - Cada reserva se liquida como mucho una vez (release XOR sale).
--
--  3. commerce_order_cancellations: anular una venta pendiente. El motor la
--     rechaza si algún cobro de la venta la retiene (en curso, incierto o
--     cobrado) o tiene un plan de cuotas vivo; toma el MISMO lock del link que
--     la confirmación de pagos (beginIn), así que anular y empezar a cobrar
--     se linealizan. Tras anular, ningún checkout abierto de la venta puede
--     empezar un cobro (guarda en payment_intents → processing) ni crear un
--     plan de cuotas.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Catálogo: imagen, variantes, control de existencias
-- ----------------------------------------------------------------------------
ALTER TABLE catalog_products
  ADD COLUMN image_ref TEXT
    CHECK (image_ref IS NULL OR image_ref ~ '^catalog/[a-z0-9-]{1,48}\.jpg$'),
  ADD COLUMN variant_of UUID,
  ADD COLUMN variant_label TEXT
    CHECK (variant_label IS NULL OR char_length(btrim(variant_label)) BETWEEN 1 AND 40),
  ADD COLUMN track_stock BOOLEAN NOT NULL DEFAULT false,
  ADD CONSTRAINT catalog_products_variant_fk
    FOREIGN KEY (variant_of, tenant_id) REFERENCES catalog_products (id, tenant_id),
  ADD CONSTRAINT catalog_products_variant_label_chk
    CHECK (variant_of IS NULL OR variant_label IS NOT NULL),
  ADD CONSTRAINT catalog_products_variant_self_chk
    CHECK (variant_of IS NULL OR variant_of <> id);

CREATE INDEX catalog_products_variant_idx ON catalog_products (variant_of)
  WHERE variant_of IS NOT NULL;

CREATE OR REPLACE FUNCTION fluvia_catalog_variant_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_parent RECORD;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.variant_of IS DISTINCT FROM OLD.variant_of THEN
      RAISE EXCEPTION 'FLUVIA_CATALOG_VARIANT: variant_of is fixed at creation'
        USING ERRCODE = 'raise_exception';
    END IF;
    IF NEW.currency IS DISTINCT FROM OLD.currency THEN
      RAISE EXCEPTION 'FLUVIA_IMMUTABLE: product currency cannot change'
        USING ERRCODE = 'raise_exception';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.variant_of IS NOT NULL THEN
    SELECT variant_of, currency, archived_at INTO v_parent
    FROM catalog_products WHERE id = NEW.variant_of AND tenant_id = NEW.tenant_id
    FOR SHARE;
    IF NOT FOUND OR v_parent.variant_of IS NOT NULL OR v_parent.archived_at IS NOT NULL
       OR v_parent.currency <> NEW.currency THEN
      RAISE EXCEPTION 'FLUVIA_CATALOG_VARIANT: invalid base product for a variant'
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER catalog_products_variant_guard
  BEFORE INSERT OR UPDATE OF variant_of, currency ON catalog_products
  FOR EACH ROW EXECUTE FUNCTION fluvia_catalog_variant_guard();

-- Las líneas copian la etiqueta de la variante (precio histórico ya copiado).
ALTER TABLE commerce_order_lines
  ADD COLUMN variant_label TEXT
    CHECK (variant_label IS NULL OR char_length(variant_label) BETWEEN 1 AND 40);

-- ----------------------------------------------------------------------------
-- 3 (antes que 2: los movimientos la referencian). Anulación de una venta.
-- ----------------------------------------------------------------------------
CREATE TABLE commerce_order_cancellations (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID NOT NULL REFERENCES organizations(id),
  order_id             UUID NOT NULL UNIQUE,
  reason               TEXT NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 200),
  cancelled_by_user_id UUID,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT commerce_order_cancellations_order_fk
    FOREIGN KEY (order_id, tenant_id) REFERENCES commerce_orders (id, tenant_id)
);

CREATE OR REPLACE FUNCTION fluvia_order_cancellation_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_link UUID;
BEGIN
  SELECT payment_link_id INTO v_link
  FROM commerce_orders WHERE id = NEW.order_id AND tenant_id = NEW.tenant_id;
  IF v_link IS NULL THEN
    RAISE EXCEPTION 'FLUVIA_ORDER_NOT_CANCELLABLE: order not found'
      USING ERRCODE = 'raise_exception';
  END IF;
  -- El MISMO lock que toma la confirmación de pagos antes de pasar a
  -- processing: anular y empezar a cobrar quedan serializados.
  PERFORM 1 FROM payment_links WHERE id = v_link FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM payment_intents
    WHERE payment_link_id = v_link
      AND status NOT IN ('created', 'requires_payment_method', 'requires_confirmation',
                         'failed', 'canceled')
  ) THEN
    RAISE EXCEPTION 'FLUVIA_ORDER_NOT_CANCELLABLE: a payment holds or charged this sale'
      USING ERRCODE = 'raise_exception';
  END IF;
  IF EXISTS (
    SELECT 1 FROM sandbox_installment_plans
    WHERE order_id = NEW.order_id AND status IN ('pending', 'approved')
  ) THEN
    RAISE EXCEPTION 'FLUVIA_ORDER_NOT_CANCELLABLE: the sale has a live installment plan'
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER commerce_order_cancellations_guard
  BEFORE INSERT ON commerce_order_cancellations
  FOR EACH ROW EXECUTE FUNCTION fluvia_order_cancellation_guard();

-- Tras anular, ningún checkout abierto de la venta empieza un cobro. Corre
-- después de que beginIn tome el lock del link (una anulación confirmada
-- antes es visible: READ COMMITTED, snapshot por sentencia).
CREATE OR REPLACE FUNCTION fluvia_cancelled_order_blocks_charge()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.payment_link_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM commerce_orders o
    JOIN commerce_order_cancellations x ON x.order_id = o.id
    WHERE o.payment_link_id = NEW.payment_link_id AND o.tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'FLUVIA_ORDER_CANCELLED: this sale was cancelled by the merchant'
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER payment_intents_cancelled_order_guard
  BEFORE UPDATE OF status ON payment_intents
  FOR EACH ROW
  WHEN (NEW.status = 'processing' AND OLD.status IS DISTINCT FROM 'processing')
  EXECUTE FUNCTION fluvia_cancelled_order_blocks_charge();

CREATE OR REPLACE FUNCTION fluvia_cancelled_order_blocks_plan()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM commerce_order_cancellations WHERE order_id = NEW.order_id) THEN
    RAISE EXCEPTION 'FLUVIA_ORDER_CANCELLED: this sale was cancelled by the merchant'
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sandbox_plans_cancelled_order_guard
  BEFORE INSERT ON sandbox_installment_plans
  FOR EACH ROW EXECUTE FUNCTION fluvia_cancelled_order_blocks_plan();

-- ----------------------------------------------------------------------------
-- 2. Existencias
-- ----------------------------------------------------------------------------
CREATE TABLE inventory_levels (
  product_id UUID PRIMARY KEY,
  tenant_id  UUID NOT NULL REFERENCES organizations(id),
  on_hand    BIGINT NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
  reserved   BIGINT NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT inventory_levels_reserved_chk CHECK (reserved <= on_hand),
  CONSTRAINT inventory_levels_product_fk
    FOREIGN KEY (product_id, tenant_id) REFERENCES catalog_products (id, tenant_id)
);

CREATE TABLE inventory_movements (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES organizations(id),
  product_id         UUID NOT NULL,
  kind               TEXT NOT NULL
    CHECK (kind IN ('receipt', 'adjustment', 'reservation', 'release', 'sale')),
  quantity           INT NOT NULL CHECK (quantity <> 0 AND abs(quantity) <= 1000000),
  order_id           UUID,
  reason             TEXT CHECK (reason IS NULL OR char_length(btrim(reason)) BETWEEN 3 AND 200),
  created_by_user_id UUID,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT inventory_movements_product_fk
    FOREIGN KEY (product_id, tenant_id) REFERENCES catalog_products (id, tenant_id),
  CONSTRAINT inventory_movements_order_fk
    FOREIGN KEY (order_id, tenant_id) REFERENCES commerce_orders (id, tenant_id),
  CONSTRAINT inventory_movements_kind_chk CHECK (
    (kind IN ('reservation', 'release', 'sale') AND order_id IS NOT NULL AND quantity > 0)
    OR (kind = 'receipt' AND order_id IS NULL AND quantity > 0 AND reason IS NOT NULL)
    OR (kind = 'adjustment' AND order_id IS NULL AND reason IS NOT NULL)
  )
);
CREATE INDEX inventory_movements_product_idx
  ON inventory_movements (tenant_id, product_id, created_at DESC);
-- Una reserva por (venta, producto); y se liquida como mucho una vez.
CREATE UNIQUE INDEX inventory_movements_reservation_uq
  ON inventory_movements (order_id, product_id) WHERE kind = 'reservation';
CREATE UNIQUE INDEX inventory_movements_settlement_uq
  ON inventory_movements (order_id, product_id) WHERE kind IN ('release', 'sale');

-- Registro VISIBLE de lo que el motor no pudo descontar al confirmar un cobro
-- (no debería ocurrir: las guardas lo impiden). El cobro jamás se bloquea por
-- existencias: lo que importa es no perder el registro de un pago.
CREATE TABLE inventory_exceptions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES organizations(id),
  order_id   UUID,
  product_id UUID,
  detail     TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Validación de cada movimiento contra el estado real de la venta.
CREATE OR REPLACE FUNCTION fluvia_inventory_movement_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_track   BOOLEAN;
  v_link    UUID;
  v_qty     BIGINT;
  v_res     BIGINT;
BEGIN
  SELECT track_stock INTO v_track FROM catalog_products
  WHERE id = NEW.product_id AND tenant_id = NEW.tenant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FLUVIA_INVENTORY: product not found' USING ERRCODE = 'raise_exception';
  END IF;

  IF NEW.kind IN ('receipt', 'adjustment', 'reservation') AND NOT v_track THEN
    RAISE EXCEPTION 'FLUVIA_INVENTORY: product does not track stock'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF NEW.order_id IS NOT NULL THEN
    SELECT payment_link_id INTO v_link FROM commerce_orders
    WHERE id = NEW.order_id AND tenant_id = NEW.tenant_id;
    SELECT coalesce(sum(quantity), 0) INTO v_qty FROM commerce_order_lines
    WHERE order_id = NEW.order_id AND tenant_id = NEW.tenant_id AND product_id = NEW.product_id;
    IF v_qty = 0 OR NEW.quantity <> v_qty THEN
      RAISE EXCEPTION 'FLUVIA_INVENTORY: quantity must match the sale lines'
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;

  IF NEW.kind = 'reservation' THEN
    IF EXISTS (SELECT 1 FROM commerce_order_cancellations WHERE order_id = NEW.order_id)
       OR EXISTS (
         SELECT 1 FROM payment_intents WHERE payment_link_id = v_link
           AND status NOT IN ('created', 'requires_payment_method', 'requires_confirmation',
                              'failed', 'canceled')) THEN
      RAISE EXCEPTION 'FLUVIA_INVENTORY: reservations only for open sales'
        USING ERRCODE = 'raise_exception';
    END IF;
  ELSIF NEW.kind IN ('release', 'sale') THEN
    SELECT quantity INTO v_res FROM inventory_movements
    WHERE order_id = NEW.order_id AND product_id = NEW.product_id AND kind = 'reservation';
    IF v_res IS NULL OR v_res <> NEW.quantity THEN
      RAISE EXCEPTION 'FLUVIA_INVENTORY: nothing reserved to settle'
        USING ERRCODE = 'raise_exception';
    END IF;
    IF NEW.kind = 'release' AND NOT EXISTS (
         SELECT 1 FROM commerce_order_cancellations WHERE order_id = NEW.order_id) THEN
      RAISE EXCEPTION 'FLUVIA_INVENTORY: only a cancelled sale releases its reservation'
        USING ERRCODE = 'raise_exception';
    END IF;
    IF NEW.kind = 'sale' AND NOT EXISTS (
         SELECT 1 FROM payment_intents WHERE payment_link_id = v_link
           AND status IN ('succeeded', 'partially_refunded', 'refunded')) THEN
      RAISE EXCEPTION 'FLUVIA_INVENTORY: stock is discounted only for a confirmed payment'
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER inventory_movements_guard
  BEFORE INSERT ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION fluvia_inventory_movement_guard();

-- Proyección del nivel: SOLO desde un movimiento (la app no escribe niveles).
CREATE OR REPLACE FUNCTION fluvia_inventory_apply()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  d_on_hand  BIGINT := 0;
  d_reserved BIGINT := 0;
BEGIN
  CASE NEW.kind
    WHEN 'receipt'     THEN d_on_hand := NEW.quantity;
    WHEN 'adjustment'  THEN d_on_hand := NEW.quantity;
    WHEN 'reservation' THEN d_reserved := NEW.quantity;
    WHEN 'release'     THEN d_reserved := -NEW.quantity;
    WHEN 'sale'        THEN d_on_hand := -NEW.quantity; d_reserved := -NEW.quantity;
  END CASE;
  -- UPDATE primero: con INSERT … ON CONFLICT el CHECK se evaluaría sobre la
  -- fila candidata (solo el delta) y rechazaría deltas legítimos.
  UPDATE inventory_levels
     SET on_hand = on_hand + d_on_hand, reserved = reserved + d_reserved, updated_at = now()
   WHERE product_id = NEW.product_id;
  IF NOT FOUND THEN
    -- Primer movimiento del producto: el lock FOR SHARE del producto (FK) no
    -- serializa dos primeros movimientos; la PK lo hace (el segundo reintenta
    -- como UPDATE vía la excepción).
    BEGIN
      INSERT INTO inventory_levels (product_id, tenant_id, on_hand, reserved, updated_at)
      VALUES (NEW.product_id, NEW.tenant_id, d_on_hand, d_reserved, now());
    EXCEPTION WHEN unique_violation THEN
      UPDATE inventory_levels
         SET on_hand = on_hand + d_on_hand, reserved = reserved + d_reserved, updated_at = now()
       WHERE product_id = NEW.product_id;
    END;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER inventory_movements_apply
  AFTER INSERT ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION fluvia_inventory_apply();

-- Descuento al CONFIRMAR el cobro (cualquier camino: API, webhook, watchdog).
CREATE OR REPLACE FUNCTION fluvia_inventory_on_payment_succeeded()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order UUID;
  r RECORD;
BEGIN
  SELECT id INTO v_order FROM commerce_orders
  WHERE payment_link_id = NEW.payment_link_id AND tenant_id = NEW.tenant_id;
  IF v_order IS NULL THEN
    RETURN NULL;
  END IF;
  FOR r IN
    SELECT m.product_id, m.quantity FROM inventory_movements m
    WHERE m.order_id = v_order AND m.kind = 'reservation'
      AND NOT EXISTS (SELECT 1 FROM inventory_movements s
                      WHERE s.order_id = v_order AND s.product_id = m.product_id
                        AND s.kind IN ('release', 'sale'))
  LOOP
    BEGIN
      INSERT INTO inventory_movements (tenant_id, product_id, kind, quantity, order_id)
      VALUES (NEW.tenant_id, r.product_id, 'sale', r.quantity, v_order);
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO inventory_exceptions (tenant_id, order_id, product_id, detail)
      VALUES (NEW.tenant_id, v_order, r.product_id, left(SQLERRM, 300));
    END;
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE TRIGGER payment_intents_inventory_sale
  AFTER UPDATE OF status ON payment_intents
  FOR EACH ROW
  WHEN (NEW.status = 'succeeded' AND OLD.status IS DISTINCT FROM 'succeeded'
        AND NEW.payment_link_id IS NOT NULL)
  EXECUTE FUNCTION fluvia_inventory_on_payment_succeeded();

-- ----------------------------------------------------------------------------
-- Append-only + RLS forzado + privilegios mínimos
-- ----------------------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['commerce_order_cancellations', 'inventory_movements',
                           'inventory_exceptions'] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION fluvia_forbid_mutation()',
      t || '_no_update', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION fluvia_forbid_mutation()',
      t || '_no_delete', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION fluvia_forbid_mutation()',
      t || '_no_truncate', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['commerce_order_cancellations', 'inventory_levels',
                           'inventory_movements', 'inventory_exceptions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)
         WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t);
  END LOOP;
END;
$$;

CREATE TRIGGER inventory_levels_no_delete
  BEFORE DELETE ON inventory_levels
  FOR EACH ROW EXECUTE FUNCTION fluvia_forbid_mutation();
CREATE TRIGGER inventory_levels_no_truncate
  BEFORE TRUNCATE ON inventory_levels
  FOR EACH STATEMENT EXECUTE FUNCTION fluvia_forbid_mutation();

-- OJO (como 0042): ALTER DEFAULT PRIVILEGES concede SELECT/INSERT/UPDATE a
-- fluvia_app sobre toda tabla NUEVA. Se revoca explícitamente: la app NO
-- escribe niveles ni excepciones (solo el motor) y no actualiza registros
-- append-only (además de los triggers).
REVOKE ALL ON commerce_order_cancellations, inventory_levels, inventory_movements,
  inventory_exceptions FROM PUBLIC, fluvia_app;
GRANT SELECT, INSERT ON commerce_order_cancellations, inventory_movements TO fluvia_app;
GRANT SELECT ON inventory_levels, inventory_exceptions TO fluvia_app;
