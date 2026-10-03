-- ============================================================================
-- FLUVIA 0065_shops_no_delete.sql
--
-- Tiendas: sin DELETE para ningún rol de runtime (invariante de la plataforma,
-- packages/db/test/tenant-escape.test.ts «no runtime role holds DELETE»).
-- 0063 concedió DELETE en favoritos, carrito y publicaciones; se revoca y el
-- «quitar» pasa a ser una ACTUALIZACIÓN:
--   - favorito: `active = false` (volver a marcar lo reactiva);
--   - línea del carrito: `quantity = 0` (no cuenta, no se muestra, no se compra);
--   - publicación: ya se oculta con `visible = false` (nunca se borraba).
-- ============================================================================
REVOKE DELETE ON shop_listings FROM fluvia_app;
REVOKE DELETE ON consumer_shop_favorites, consumer_cart_items FROM fluvia_app;

ALTER TABLE consumer_shop_favorites
  ADD COLUMN active BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE consumer_cart_items DROP CONSTRAINT consumer_cart_items_quantity_check;
ALTER TABLE consumer_cart_items
  ADD CONSTRAINT consumer_cart_items_quantity_check CHECK (quantity BETWEEN 0 AND 99);

CREATE INDEX consumer_cart_items_live_idx
  ON consumer_cart_items (tenant_id, consumer_id) WHERE quantity > 0;
