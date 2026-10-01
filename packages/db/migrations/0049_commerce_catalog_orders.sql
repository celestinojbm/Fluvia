-- ============================================================================
-- FLUVIA 0049_commerce_catalog_orders.sql  (Plataforma del comercio — sandbox)
--
-- Mínimo modelo persistente para el recorrido catálogo → venta → cobro:
--
--  1. catalog_categories / catalog_products: catálogo por organización
--     (tenant). Precio en UNIDADES MENORES (BIGINT) + moneda; `available`
--     es la disponibilidad declarada por el comercio (NO existencias: no hay
--     inventario en este incremento). Baja lógica con archived_at.
--
--  2. commerce_orders + commerce_order_lines: la VENTA con sus líneas.
--     - El total lo calcula el SERVIDOR desde el catálogo; las líneas
--       guardan una COPIA (nombre, sku, precio unitario) para conservar el
--       detalle y el precio HISTÓRICO aunque luego cambie el catálogo.
--     - Pedido y líneas son INMUTABLES (append-only).
--     - Cada pedido crea en la MISMA transacción su payment link de cobro
--       único (0046): el cobro sigue el flujo existente (checkout alojado,
--       guardas de doble cobro, incertidumbre). El estado de pago del pedido
--       NO se guarda aquí: se DERIVA de los intents del link (una sola
--       fuente de verdad).
--     - Invariantes en el MOTOR (constraint trigger diferido, al COMMIT):
--       total = Σ líneas, nº de líneas coherente, y el link del pedido es de
--       cobro único, del mismo comercio, por el MISMO importe y moneda.
--
-- No toca ledger, reglas monetarias, FSM de pagos ni datos existentes:
-- solo crea tablas nuevas (aditiva). Aislamiento: RLS FORZADO por tenant +
-- FKs compuestas (id, tenant_id) — nada cruza organización.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Catálogo
-- ----------------------------------------------------------------------------
CREATE TABLE catalog_categories (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES organizations(id),
  name        TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ,
  UNIQUE (id, tenant_id)
);
CREATE UNIQUE INDEX catalog_categories_name_uq
  ON catalog_categories (tenant_id, lower(btrim(name))) WHERE archived_at IS NULL;

CREATE TABLE catalog_products (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES organizations(id),
  category_id UUID,
  name        TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  sku         TEXT CHECK (sku IS NULL OR char_length(sku) BETWEEN 1 AND 64),
  description TEXT CHECK (description IS NULL OR char_length(description) <= 500),
  -- Unidades menores; tope = entero seguro de JS (la API serializa número).
  price       BIGINT NOT NULL CHECK (price > 0 AND price <= 9007199254740991),
  currency    CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  available   BOOLEAN NOT NULL DEFAULT true,
  -- Concurrencia optimista de la edición (dos operadores editando a la vez).
  version     INT NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ,
  UNIQUE (id, tenant_id),
  CONSTRAINT catalog_products_category_fk
    FOREIGN KEY (category_id, tenant_id) REFERENCES catalog_categories (id, tenant_id)
);
CREATE INDEX catalog_products_tenant_idx ON catalog_products (tenant_id, name);
CREATE UNIQUE INDEX catalog_products_sku_uq
  ON catalog_products (tenant_id, sku) WHERE sku IS NOT NULL AND archived_at IS NULL;

-- ----------------------------------------------------------------------------
-- 2. Pedidos (ventas con líneas)
-- ----------------------------------------------------------------------------
-- Numeración legible por organización (no fiscal: PEND-007).
CREATE TABLE commerce_order_counters (
  tenant_id   UUID PRIMARY KEY REFERENCES organizations(id),
  last_number BIGINT NOT NULL CHECK (last_number >= 0)
);

CREATE TABLE commerce_orders (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES organizations(id),
  number             BIGINT NOT NULL CHECK (number >= 1),
  merchant_id        UUID NOT NULL,
  customer_id        UUID,
  currency           CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  total              BIGINT NOT NULL CHECK (total > 0 AND total <= 9007199254740991),
  line_count         INT NOT NULL CHECK (line_count BETWEEN 1 AND 50),
  note               TEXT CHECK (note IS NULL OR char_length(note) <= 280),
  payment_link_id    UUID NOT NULL UNIQUE,
  created_by_user_id UUID,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, number),
  CONSTRAINT commerce_orders_merchant_fk
    FOREIGN KEY (merchant_id, tenant_id) REFERENCES merchants (id, tenant_id),
  CONSTRAINT commerce_orders_customer_fk
    FOREIGN KEY (customer_id, tenant_id) REFERENCES customers (id, tenant_id),
  CONSTRAINT commerce_orders_link_fk
    FOREIGN KEY (payment_link_id, tenant_id) REFERENCES payment_links (id, tenant_id)
);
CREATE INDEX commerce_orders_tenant_idx ON commerce_orders (tenant_id, number DESC);
CREATE INDEX commerce_orders_customer_idx ON commerce_orders (tenant_id, customer_id)
  WHERE customer_id IS NOT NULL;

CREATE TABLE commerce_order_lines (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES organizations(id),
  order_id   UUID NOT NULL,
  position   INT NOT NULL CHECK (position BETWEEN 1 AND 50),
  product_id UUID,
  -- Copia histórica: el pedido NO cambia si el producto cambia o se archiva.
  name       TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  sku        TEXT,
  unit_price BIGINT NOT NULL CHECK (unit_price > 0),
  quantity   INT NOT NULL CHECK (quantity BETWEEN 1 AND 999),
  line_total BIGINT NOT NULL CHECK (line_total > 0),
  currency   CHAR(3) NOT NULL,
  UNIQUE (order_id, position),
  CONSTRAINT commerce_order_lines_math_chk CHECK (line_total = unit_price * quantity),
  CONSTRAINT commerce_order_lines_order_fk
    FOREIGN KEY (order_id, tenant_id) REFERENCES commerce_orders (id, tenant_id),
  CONSTRAINT commerce_order_lines_product_fk
    FOREIGN KEY (product_id, tenant_id) REFERENCES catalog_products (id, tenant_id)
);
CREATE INDEX commerce_order_lines_order_idx ON commerce_order_lines (order_id, position);

-- Inmutabilidad: pedido y líneas son registro histórico (sin UPDATE/DELETE).
CREATE TRIGGER commerce_orders_no_update
  BEFORE UPDATE ON commerce_orders
  FOR EACH ROW EXECUTE FUNCTION fluvia_forbid_mutation();
CREATE TRIGGER commerce_order_lines_no_update
  BEFORE UPDATE ON commerce_order_lines
  FOR EACH ROW EXECUTE FUNCTION fluvia_forbid_mutation();
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['catalog_categories', 'catalog_products',
                           'commerce_orders', 'commerce_order_lines'] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION fluvia_forbid_mutation()',
      t || '_no_delete', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION fluvia_forbid_mutation()',
      t || '_no_truncate', t);
  END LOOP;
END;
$$;

-- Invariantes del pedido, verificadas al COMMIT (las líneas se insertan
-- después de la cabecera en la misma transacción).
CREATE OR REPLACE FUNCTION fluvia_commerce_order_check()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_sum   NUMERIC;
  v_count INT;
  v_bad   INT;
  v_link  RECORD;
BEGIN
  SELECT coalesce(sum(line_total), 0), count(*),
         count(*) FILTER (WHERE currency <> NEW.currency)
    INTO v_sum, v_count, v_bad
  FROM commerce_order_lines WHERE order_id = NEW.id AND tenant_id = NEW.tenant_id;

  IF v_count <> NEW.line_count OR v_sum <> NEW.total OR v_bad > 0 THEN
    RAISE EXCEPTION 'FLUVIA_ORDER_INVARIANT: order total/lines mismatch'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT merchant_id, amount, currency, single_charge INTO v_link
  FROM payment_links WHERE id = NEW.payment_link_id AND tenant_id = NEW.tenant_id;
  IF NOT FOUND OR NOT v_link.single_charge OR v_link.merchant_id <> NEW.merchant_id
     OR v_link.amount <> NEW.total OR v_link.currency <> NEW.currency THEN
    RAISE EXCEPTION 'FLUVIA_ORDER_INVARIANT: order payment link mismatch'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER commerce_orders_invariant
  AFTER INSERT ON commerce_orders
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION fluvia_commerce_order_check();

-- Una línea añadida DESPUÉS (otra transacción) rompería Σ líneas = total: se
-- revalida el pedido al COMMIT de cualquier inserción de líneas.
CREATE OR REPLACE FUNCTION fluvia_commerce_line_check()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_order commerce_orders%ROWTYPE;
  v_sum   NUMERIC;
  v_count INT;
BEGIN
  SELECT * INTO v_order FROM commerce_orders
  WHERE id = NEW.order_id AND tenant_id = NEW.tenant_id;
  SELECT coalesce(sum(line_total), 0), count(*) INTO v_sum, v_count
  FROM commerce_order_lines WHERE order_id = NEW.order_id AND tenant_id = NEW.tenant_id;
  IF NOT FOUND OR v_order.id IS NULL OR v_count <> v_order.line_count OR v_sum <> v_order.total
     OR NEW.currency <> v_order.currency THEN
    RAISE EXCEPTION 'FLUVIA_ORDER_INVARIANT: order total/lines mismatch'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER commerce_order_lines_invariant
  AFTER INSERT ON commerce_order_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION fluvia_commerce_line_check();

-- ----------------------------------------------------------------------------
-- RLS forzado + privilegios mínimos (rol de la app)
-- ----------------------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['catalog_categories', 'catalog_products', 'commerce_order_counters',
                           'commerce_orders', 'commerce_order_lines'] LOOP
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

GRANT SELECT, INSERT, UPDATE ON catalog_categories, catalog_products, commerce_order_counters
  TO fluvia_app;
GRANT SELECT, INSERT ON commerce_orders, commerce_order_lines TO fluvia_app;
