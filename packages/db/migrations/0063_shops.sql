-- ============================================================================
-- FLUVIA 0063_shops.sql  (jornada Personal móvil + Tiendas)
--
-- «Tiendas Fluvia»: el comercio vende su catálogo existente a clientes de
-- Fluvia Personal. Reglas:
--  * Visibilidad EXPLÍCITA en dos niveles: la tienda solo es visible si su
--    perfil del directorio está publicado (0054) Y la tienda está activada; y
--    cada producto se publica uno a uno (shop_listings). Nada se publica solo.
--  * Lectura pública por funciones SECURITY DEFINER de solo lectura que
--    devuelven columnas públicas: sin costos, sin cantidades de inventario
--    (solo disponible/agotado), sin clientes ni ids de organización.
--  * El pedido es un pedido NORMAL del comercio (commerce_orders, 0049–0051):
--    precio del servidor, reserva de existencias, enlace de cobro único y
--    estado de pago derivado. Aquí solo se añade la solicitud de la tienda
--    (idempotencia, comprador, entrega) en la MISMA transacción del pedido.
--  * Lado del cliente (tenant del PROGRAMA): favoritos, carrito y la relación
--    cliente ↔ pedido. RLS por tenant como el resto de Personal.
-- Sin DELETE en tablas de pedidos; carrito y favoritos sí se borran (son
-- preferencias del cliente, no registros financieros).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Tienda del comercio (tenant del comercio)
-- ---------------------------------------------------------------------------
CREATE TABLE shop_settings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES organizations(id),
  merchant_id     UUID NOT NULL,
  enabled         BOOLEAN NOT NULL DEFAULT false,
  pickup          BOOLEAN NOT NULL DEFAULT true,
  delivery        BOOLEAN NOT NULL DEFAULT false,
  delivery_terms  TEXT CHECK (delivery_terms IS NULL OR char_length(delivery_terms) <= 400),
  returns_policy  TEXT CHECK (returns_policy IS NULL OR char_length(returns_policy) <= 600),
  contact_email   TEXT CHECK (contact_email IS NULL
                     OR (char_length(contact_email) <= 120 AND contact_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  contact_phone   TEXT CHECK (contact_phone IS NULL OR contact_phone ~ '^\+?[0-9 ()-]{7,20}$'),
  banner_ref      TEXT CHECK (banner_ref IS NULL
                     OR banner_ref ~ '^(presentacion|catalog)/[a-z0-9-]{1,48}\.jpg$'),
  version         INT NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT shop_settings_merchant_uniq UNIQUE (tenant_id, merchant_id),
  CONSTRAINT shop_settings_merchant_fk
    FOREIGN KEY (merchant_id, tenant_id) REFERENCES merchants (id, tenant_id),
  CONSTRAINT shop_settings_fulfillment_chk CHECK (pickup OR delivery)
);

CREATE TABLE shop_listings (
  tenant_id   UUID NOT NULL REFERENCES organizations(id),
  product_id  UUID NOT NULL,
  visible     BOOLEAN NOT NULL DEFAULT true,
  featured    BOOLEAN NOT NULL DEFAULT false,
  collection  TEXT CHECK (collection IS NULL OR char_length(btrim(collection)) BETWEEN 1 AND 40),
  position    INT NOT NULL DEFAULT 0 CHECK (position BETWEEN 0 AND 10000),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, product_id),
  CONSTRAINT shop_listings_product_fk
    FOREIGN KEY (product_id, tenant_id) REFERENCES catalog_products (id, tenant_id)
);

-- Solicitud de la tienda: nace en la MISMA transacción que el pedido.
-- `request_hash` = sha256(cliente + clave de idempotencia): un reintento con
-- la misma clave devuelve el mismo pedido (UNIQUE), nunca uno nuevo.
CREATE TABLE shop_order_requests (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES organizations(id),
  order_id            UUID NOT NULL UNIQUE,
  request_hash        TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  program_tenant_id   UUID NOT NULL,
  consumer_id         UUID NOT NULL,
  buyer_name          TEXT NOT NULL CHECK (char_length(btrim(buyer_name)) BETWEEN 1 AND 80),
  buyer_email         TEXT NOT NULL CHECK (char_length(buyer_email) <= 254),
  fulfillment         TEXT NOT NULL CHECK (fulfillment IN ('pickup', 'delivery')),
  delivery_address    TEXT CHECK (delivery_address IS NULL OR char_length(delivery_address) <= 240),
  fulfillment_status  TEXT NOT NULL DEFAULT 'received'
                        CHECK (fulfillment_status IN
                          ('received', 'preparing', 'ready', 'shipped', 'delivered', 'cancelled')),
  return_requested_at TIMESTAMPTZ,
  return_reason       TEXT CHECK (return_reason IS NULL OR char_length(return_reason) <= 280),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT shop_order_requests_hash_uniq UNIQUE (tenant_id, request_hash),
  CONSTRAINT shop_order_requests_order_fk
    FOREIGN KEY (order_id, tenant_id) REFERENCES commerce_orders (id, tenant_id),
  CONSTRAINT shop_order_requests_delivery_chk
    CHECK (fulfillment = 'pickup' OR delivery_address IS NOT NULL),
  CONSTRAINT shop_order_requests_return_chk
    CHECK ((return_requested_at IS NULL) = (return_reason IS NULL))
);
CREATE INDEX shop_order_requests_consumer_idx
  ON shop_order_requests (program_tenant_id, consumer_id, created_at DESC);

-- Estados de entrega: solo hacia delante (o cancelado), nunca hacia atrás.
CREATE FUNCTION fluvia_shop_fulfillment_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_rank CONSTANT TEXT[] := ARRAY['received', 'preparing', 'ready', 'shipped', 'delivered'];
BEGIN
  IF NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.consumer_id IS DISTINCT FROM OLD.consumer_id
     OR NEW.program_tenant_id IS DISTINCT FROM OLD.program_tenant_id
     OR NEW.buyer_name IS DISTINCT FROM OLD.buyer_name
     OR NEW.buyer_email IS DISTINCT FROM OLD.buyer_email
     OR NEW.fulfillment IS DISTINCT FROM OLD.fulfillment
     OR NEW.delivery_address IS DISTINCT FROM OLD.delivery_address THEN
    RAISE EXCEPTION 'FLUVIA_SHOP_REQUEST_IMMUTABLE: request fields are fixed'
      USING ERRCODE = 'raise_exception';
  END IF;
  IF NEW.fulfillment_status IS DISTINCT FROM OLD.fulfillment_status THEN
    IF OLD.fulfillment_status IN ('delivered', 'cancelled') THEN
      RAISE EXCEPTION 'FLUVIA_SHOP_FULFILLMENT: % is final', OLD.fulfillment_status
        USING ERRCODE = 'raise_exception';
    END IF;
    IF NEW.fulfillment_status <> 'cancelled'
       AND array_position(v_rank, NEW.fulfillment_status)
           <= array_position(v_rank, OLD.fulfillment_status) THEN
      RAISE EXCEPTION 'FLUVIA_SHOP_FULFILLMENT: % -> % not allowed',
        OLD.fulfillment_status, NEW.fulfillment_status USING ERRCODE = 'raise_exception';
    END IF;
  END IF;
  IF OLD.return_requested_at IS NOT NULL
     AND NEW.return_requested_at IS DISTINCT FROM OLD.return_requested_at THEN
    RAISE EXCEPTION 'FLUVIA_SHOP_RETURN: return request already recorded'
      USING ERRCODE = 'raise_exception';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER shop_order_requests_guard
  BEFORE UPDATE ON shop_order_requests
  FOR EACH ROW EXECUTE FUNCTION fluvia_shop_fulfillment_guard();
CREATE TRIGGER shop_order_requests_no_delete
  BEFORE DELETE ON shop_order_requests
  FOR EACH ROW EXECUTE FUNCTION fluvia_forbid_mutation();
CREATE TRIGGER shop_order_requests_no_truncate
  BEFORE TRUNCATE ON shop_order_requests
  FOR EACH STATEMENT EXECUTE FUNCTION fluvia_forbid_mutation();

-- ---------------------------------------------------------------------------
-- 2. Lado del cliente (tenant del PROGRAMA de Fluvia Personal)
-- ---------------------------------------------------------------------------
CREATE TABLE consumer_shop_favorites (
  tenant_id        UUID NOT NULL REFERENCES organizations(id),
  consumer_id      UUID NOT NULL,
  shop_tenant_id   UUID NOT NULL,
  shop_merchant_id UUID NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, consumer_id, shop_merchant_id)
);

CREATE TABLE consumer_cart_items (
  tenant_id        UUID NOT NULL REFERENCES organizations(id),
  consumer_id      UUID NOT NULL,
  shop_tenant_id   UUID NOT NULL,
  shop_merchant_id UUID NOT NULL,
  product_id       UUID NOT NULL,
  quantity         INT NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  -- Precio y moneda que el cliente VIO al añadir: si el servidor calcula otro
  -- al revisar, se le muestra el cambio antes de pagar.
  unit_price_seen  BIGINT NOT NULL CHECK (unit_price_seen > 0),
  currency         CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  added_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, consumer_id, product_id)
);
CREATE INDEX consumer_cart_items_shop_idx
  ON consumer_cart_items (tenant_id, consumer_id, shop_merchant_id);

CREATE TABLE consumer_shop_orders (
  tenant_id        UUID NOT NULL REFERENCES organizations(id),
  consumer_id      UUID NOT NULL,
  shop_tenant_id   UUID NOT NULL,
  shop_merchant_id UUID NOT NULL,
  order_id         UUID NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, order_id)
);
CREATE INDEX consumer_shop_orders_consumer_idx
  ON consumer_shop_orders (tenant_id, consumer_id, created_at DESC);
CREATE TRIGGER consumer_shop_orders_no_delete
  BEFORE DELETE ON consumer_shop_orders
  FOR EACH ROW EXECUTE FUNCTION fluvia_forbid_mutation();

-- ---------------------------------------------------------------------------
-- 3. RLS (forzado) y permisos
-- ---------------------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['shop_settings', 'shop_listings', 'shop_order_requests',
                           'consumer_shop_favorites', 'consumer_cart_items',
                           'consumer_shop_orders'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)
         WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON shop_settings, shop_listings, shop_order_requests TO fluvia_app;
GRANT DELETE ON shop_listings TO fluvia_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON consumer_shop_favorites, consumer_cart_items TO fluvia_app;
GRANT SELECT, INSERT ON consumer_shop_orders TO fluvia_app;

-- ---------------------------------------------------------------------------
-- 4. Lectura pública (cross-tenant), solo tiendas VISIBLES: perfil publicado
--    + tienda activada + comercio activo. Jamás tenant_id ni datos internos.
-- ---------------------------------------------------------------------------
CREATE FUNCTION shop_visible_rows()
RETURNS TABLE (
  tenant_id UUID, merchant_id UUID, slug TEXT, display_name TEXT, category TEXT,
  city TEXT, area TEXT, summary TEXT, photo_ref TEXT, is_demo BOOLEAN,
  pickup BOOLEAN, delivery BOOLEAN, delivery_terms TEXT, returns_policy TEXT,
  contact_email TEXT, contact_phone TEXT, banner_ref TEXT
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT d.tenant_id, d.merchant_id, d.slug, d.display_name, d.category, d.city, d.area,
         d.summary, d.photo_ref, d.is_demo, s.pickup, s.delivery, s.delivery_terms,
         s.returns_policy, s.contact_email, s.contact_phone, s.banner_ref
    FROM merchant_directory_profiles d
    JOIN shop_settings s ON s.tenant_id = d.tenant_id AND s.merchant_id = d.merchant_id
                        AND s.enabled
    JOIN merchants m ON m.id = d.merchant_id AND m.tenant_id = d.tenant_id
                    AND m.status = 'active' AND m.deleted_at IS NULL
    JOIN organizations o ON o.id = d.tenant_id AND o.deleted_at IS NULL
   WHERE d.visibility = 'published';
$$;
REVOKE ALL ON FUNCTION shop_visible_rows() FROM PUBLIC;
-- Solo la usan las funciones de abajo (y el servidor para resolver una tienda
-- por slug: tenant/merchant NUNCA salen de la API).
GRANT EXECUTE ON FUNCTION shop_visible_rows() TO fluvia_app;

-- Productos publicados y vendibles de las tiendas visibles. `in_stock` es la
-- única señal de inventario: sin cantidades.
CREATE FUNCTION shop_product_rows()
RETURNS TABLE (
  shop_slug TEXT, product_id UUID, name TEXT, description TEXT, price BIGINT,
  currency TEXT, image_ref TEXT, variant_of UUID, variant_label TEXT,
  category_name TEXT, featured BOOLEAN, collection TEXT, list_position INT, in_stock BOOLEAN
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT v.slug, p.id, p.name, p.description, p.price, btrim(p.currency), p.image_ref,
         p.variant_of, p.variant_label, c.name,
         COALESCE(lb.featured, false), lb.collection, COALESCE(lb.position, 0),
         (NOT p.track_stock OR COALESCE(il.on_hand - il.reserved, 0) > 0)
    FROM shop_visible_rows() v
    JOIN catalog_products p ON p.tenant_id = v.tenant_id
                           AND p.archived_at IS NULL AND p.available
    -- Publicado: el producto base (o él mismo) tiene una publicación visible.
    JOIN shop_listings lb ON lb.tenant_id = p.tenant_id
                         AND lb.product_id = COALESCE(p.variant_of, p.id) AND lb.visible
    LEFT JOIN catalog_categories c ON c.id = p.category_id AND c.tenant_id = p.tenant_id
    LEFT JOIN inventory_levels il ON il.product_id = p.id AND il.tenant_id = p.tenant_id;
$$;
REVOKE ALL ON FUNCTION shop_product_rows() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION shop_product_rows() TO fluvia_app;
