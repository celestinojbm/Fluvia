import { createHash } from 'node:crypto';
import { withTenantTransaction, type Pool, type PoolClient } from '@fluvia/db';
import { CommerceError, hasEngineMessage, isCheckViolation } from './errors.js';
import type { OrderDetailDto, OrderService } from './orders.js';

/**
 * «Tiendas Fluvia» (0063/0064).
 *
 * Tres planos:
 *  - COMERCIO (tenant del comercio, sesión del comercio): activar la tienda,
 *    condiciones de entrega/contacto/políticas, qué productos publica, pedidos
 *    en línea y su estado de entrega.
 *  - PÚBLICO (lectura cross-tenant por funciones SECURITY DEFINER): tiendas
 *    visibles y productos publicados; columnas públicas, sin ids de tenant ni
 *    cantidades de inventario.
 *  - CLIENTE (tenant del programa + `app.consumer_id`): favoritos, carrito y
 *    sus pedidos. El pedido es un pedido NORMAL del comercio (`OrderService`):
 *    precio del servidor, reserva de existencias, enlace de cobro único y
 *    estado de pago DERIVADO. Nada aquí marca un pedido como pagado.
 */

export class ShopNotFoundError extends CommerceError {
  constructor() {
    super('Shop not found');
  }
}
export class ShopProductNotFoundError extends CommerceError {
  constructor() {
    super('Product not found in this shop');
  }
}
export class ShopCartEmptyError extends CommerceError {
  constructor() {
    super('Nothing in the cart for this shop and currency');
  }
}
export class ShopCartCurrencyError extends CommerceError {
  constructor() {
    super('Cart lines must share the shop currency');
  }
}
export class ShopFulfillmentError extends CommerceError {
  constructor(message = 'Fulfillment option not offered by this shop') {
    super(message);
  }
}
export class ShopVersionConflictError extends CommerceError {
  constructor() {
    super('Shop settings were modified by someone else');
  }
}
export class ShopOrderStateError extends CommerceError {
  constructor(message: string) {
    super(message);
  }
}
export class ShopNotPublishableError extends CommerceError {
  constructor() {
    super('Publish the directory profile before enabling the shop');
  }
}

export const SHOP_FULFILLMENT_STATUSES = [
  'received',
  'preparing',
  'ready',
  'shipped',
  'delivered',
  'cancelled',
] as const;
export type ShopFulfillmentStatus = (typeof SHOP_FULFILLMENT_STATUSES)[number];
export const SHOP_CART_MAX_LINES = 30;
export const SHOP_CART_MAX_QUANTITY = 99;

// ── Formas ───────────────────────────────────────────────────────────────────
export interface ShopSummary {
  slug: string;
  name: string;
  category: string;
  city: string;
  area: string | null;
  summary: string | null;
  photoRef: string | null;
  bannerRef: string | null;
  isDemo: boolean;
  pickup: boolean;
  delivery: boolean;
  currencies: string[];
  productCount: number;
  favorite: boolean;
}
export interface ShopProfile extends ShopSummary {
  deliveryTerms: string | null;
  returnsPolicy: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
}
export interface ShopVariant {
  id: string;
  label: string;
  price: bigint;
  currency: string;
  inStock: boolean;
}
export interface ShopProduct {
  id: string;
  shopSlug: string;
  shopName?: string;
  name: string;
  description: string | null;
  price: bigint;
  currency: string;
  imageRef: string | null;
  category: string | null;
  featured: boolean;
  collection: string | null;
  inStock: boolean;
  /** Variantes vendibles (el producto base puede no venderse solo). */
  variants: ShopVariant[];
  /** El producto base se puede comprar tal cual (no es solo un contenedor). */
  sellable: boolean;
}
export interface CartLine {
  productId: string;
  name: string;
  variantLabel: string | null;
  imageRef: string | null;
  quantity: number;
  unitPriceSeen: bigint;
  /** Precio vigente del servidor (null si el producto ya no se vende). */
  unitPrice: bigint | null;
  currency: string;
  inStock: boolean;
  status: 'ok' | 'price_changed' | 'unavailable' | 'out_of_stock';
}
export interface CartGroup {
  shopSlug: string;
  shopName: string;
  currency: string;
  pickup: boolean;
  delivery: boolean;
  lines: CartLine[];
  /** Total con precios VIGENTES de las líneas comprables. */
  total: bigint;
  /** Total con los precios que el cliente vio. */
  totalSeen: bigint;
  ready: boolean;
}
export interface ShopOrderView {
  orderId: string;
  shopSlug: string | null;
  shopName: string;
  number: number;
  createdAt: string;
  currency: string;
  total: bigint;
  lines: OrderDetailDto['lines'];
  payment: OrderDetailDto['payment'];
  installments: OrderDetailDto['installments'];
  cancellation: OrderDetailDto['cancellation'];
  fulfillment: 'pickup' | 'delivery';
  deliveryAddress: string | null;
  fulfillmentStatus: ShopFulfillmentStatus;
  returnRequestedAt: string | null;
  returnReason: string | null;
  /** Solo para el servidor: enlace de cobro de la venta (pago). */
  paymentLinkId: string;
}
export interface ShopSettingsDto {
  merchantId: string;
  enabled: boolean;
  pickup: boolean;
  delivery: boolean;
  deliveryTerms: string | null;
  returnsPolicy: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  bannerRef: string | null;
  version: number;
}
export interface ShopAdminView {
  settings: ShopSettingsDto | null;
  directory: { slug: string; displayName: string; visibility: string } | null;
  listings: Array<{
    productId: string;
    name: string;
    price: bigint;
    currency: string;
    imageRef: string | null;
    available: boolean;
    listed: boolean;
    visible: boolean;
    featured: boolean;
    collection: string | null;
    position: number;
    variantCount: number;
  }>;
}
export interface ShopAdminOrder {
  orderId: string;
  number: number;
  createdAt: string;
  currency: string;
  total: bigint;
  paymentState: string;
  buyerName: string;
  buyerEmail: string;
  fulfillment: 'pickup' | 'delivery';
  deliveryAddress: string | null;
  fulfillmentStatus: ShopFulfillmentStatus;
  returnRequestedAt: string | null;
  returnReason: string | null;
}

interface VisibleRow {
  tenant_id: string;
  merchant_id: string;
  slug: string;
  display_name: string;
  category: string;
  city: string;
  area: string | null;
  summary: string | null;
  photo_ref: string | null;
  is_demo: boolean;
  pickup: boolean;
  delivery: boolean;
  delivery_terms: string | null;
  returns_policy: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  banner_ref: string | null;
}
interface ProductRow {
  shop_slug: string;
  product_id: string;
  name: string;
  description: string | null;
  price: string;
  currency: string;
  image_ref: string | null;
  variant_of: string | null;
  variant_label: string | null;
  category_name: string | null;
  featured: boolean;
  collection: string | null;
  list_position: number;
  in_stock: boolean;
}

/** Patrón ILIKE con comodines escapados (la búsqueda nunca interpreta `%`/`_`). */
export function shopLikePattern(q: string | undefined): string | null {
  const t = (q ?? '').trim();
  if (!t) return null;
  return `%${t.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

/** Agrupa filas públicas en productos con variantes (orden: destacado, posición, nombre). */
export function groupProducts(rows: ProductRow[], shopName?: string): ShopProduct[] {
  const bases = new Map<string, ShopProduct>();
  const variants: ProductRow[] = [];
  for (const r of rows) {
    if (r.variant_of) {
      variants.push(r);
      continue;
    }
    bases.set(r.product_id, {
      id: r.product_id,
      shopSlug: r.shop_slug,
      ...(shopName ? { shopName } : {}),
      name: r.name,
      description: r.description,
      price: BigInt(r.price),
      currency: r.currency,
      imageRef: r.image_ref,
      category: r.category_name,
      featured: r.featured,
      collection: r.collection,
      inStock: r.in_stock,
      variants: [],
      sellable: true,
    });
  }
  for (const v of variants) {
    const base = bases.get(v.variant_of!);
    if (!base) continue; // base archivada o no vendible: la variante no se ofrece sola
    base.variants.push({
      id: v.product_id,
      label: v.variant_label ?? v.name,
      price: BigInt(v.price),
      currency: v.currency,
      inStock: v.in_stock,
    });
  }
  const out = [...bases.values()].map((p) => {
    if (p.variants.length) {
      p.variants.sort((a, b) => a.label.localeCompare(b.label, 'es'));
      // Con variantes, el cliente elige una; «desde» = la más barata en existencia.
      p.sellable = false;
      const live = p.variants.filter((v) => v.inStock);
      p.inStock = live.length > 0;
      const min = (live.length ? live : p.variants).reduce(
        (m, v) => (v.price < m ? v.price : m),
        p.variants[0]!.price
      );
      p.price = min;
    }
    return p;
  });
  const pos = new Map(rows.map((r) => [r.product_id, r.list_position]));
  return out.sort(
    (a, b) =>
      Number(b.featured) - Number(a.featured) ||
      (pos.get(a.id) ?? 0) - (pos.get(b.id) ?? 0) ||
      a.name.localeCompare(b.name, 'es')
  );
}

export function requestHash(consumerId: string, idempotencyKey: string): string {
  return createHash('sha256').update(`shop-order:${consumerId}:${idempotencyKey}`).digest('hex');
}

export class ShopService {
  constructor(
    /** Pool fluvia_app (RLS forzado). */
    private readonly appPool: Pool,
    private readonly orders: OrderService
  ) {}

  // ── Público ────────────────────────────────────────────────────────────────
  private async visible(c: Pool | PoolClient, slug?: string): Promise<VisibleRow[]> {
    const r = await c.query<VisibleRow>(
      slug
        ? `SELECT * FROM shop_visible_rows() WHERE slug = $1`
        : `SELECT * FROM shop_visible_rows() ORDER BY display_name, slug`,
      slug ? [slug] : []
    );
    return r.rows;
  }

  /** Resuelve una tienda visible (uso interno del servidor: tenant y comercio). */
  async resolve(slug: string): Promise<VisibleRow> {
    const [row] = await this.visible(this.appPool, slug);
    if (!row) throw new ShopNotFoundError();
    return row;
  }

  async listShops(opts: {
    q?: string;
    category?: string;
    favorites?: Set<string>;
    onlyFavorites?: boolean;
  }): Promise<ShopSummary[]> {
    const pattern = shopLikePattern(opts.q);
    const rows = await this.appPool.query<
      VisibleRow & { product_count: number; currencies: string[] }
    >(
      `SELECT v.*, COALESCE(p.n, 0)::int AS product_count, COALESCE(p.cur, '{}') AS currencies
         FROM shop_visible_rows() v
         LEFT JOIN LATERAL (
           SELECT count(*) FILTER (WHERE r.variant_of IS NULL) AS n,
                  array_agg(DISTINCT r.currency) AS cur
             FROM shop_product_rows() r WHERE r.shop_slug = v.slug
         ) p ON true
        WHERE ($1::text IS NULL OR v.category = $1)
          AND ($2::text IS NULL OR v.display_name ILIKE $2 ESCAPE '\\'
               OR v.summary ILIKE $2 ESCAPE '\\'
               OR EXISTS (SELECT 1 FROM shop_product_rows() x
                           WHERE x.shop_slug = v.slug AND x.name ILIKE $2 ESCAPE '\\'))
        ORDER BY v.display_name, v.slug`,
      [opts.category ?? null, pattern]
    );
    return rows.rows
      .map((r) => this.summary(r, r.product_count, r.currencies, opts.favorites))
      .filter((s) => !opts.onlyFavorites || s.favorite);
  }

  private summary(
    r: VisibleRow,
    productCount: number,
    currencies: string[],
    favorites?: Set<string>
  ): ShopSummary {
    return {
      slug: r.slug,
      name: r.display_name,
      category: r.category,
      city: r.city,
      area: r.area,
      summary: r.summary,
      photoRef: r.photo_ref,
      bannerRef: r.banner_ref,
      isDemo: r.is_demo,
      pickup: r.pickup,
      delivery: r.delivery,
      currencies: [...currencies].sort(),
      productCount,
      favorite: favorites?.has(r.merchant_id) ?? false,
    };
  }

  async shop(
    slug: string,
    favorites?: Set<string>
  ): Promise<{ shop: ShopProfile; products: ShopProduct[] }> {
    const v = await this.resolve(slug);
    const rows = await this.appPool.query<ProductRow>(
      `SELECT * FROM shop_product_rows() WHERE shop_slug = $1`,
      [slug]
    );
    const products = groupProducts(rows.rows);
    const currencies = [...new Set(products.map((p) => p.currency))];
    return {
      shop: {
        ...this.summary(v, products.length, currencies, favorites),
        deliveryTerms: v.delivery_terms,
        returnsPolicy: v.returns_policy,
        contactEmail: v.contact_email,
        contactPhone: v.contact_phone,
      },
      products,
    };
  }

  async product(
    slug: string,
    productId: string
  ): Promise<{ shop: ShopProfile; product: ShopProduct }> {
    const { shop, products } = await this.shop(slug);
    const product = products.find(
      (p) => p.id === productId || p.variants.some((v) => v.id === productId)
    );
    if (!product) throw new ShopProductNotFoundError();
    return { shop, product };
  }

  /** Búsqueda de productos en todas las tiendas visibles. */
  async searchProducts(q: string, limit = 24): Promise<ShopProduct[]> {
    const pattern = shopLikePattern(q);
    if (!pattern) return [];
    const rows = await this.appPool.query<ProductRow & { shop_name: string }>(
      `SELECT r.*, v.display_name AS shop_name
         FROM shop_product_rows() r JOIN shop_visible_rows() v ON v.slug = r.shop_slug
        WHERE r.shop_slug IN (SELECT shop_slug FROM shop_product_rows()
                               WHERE name ILIKE $1 ESCAPE '\\' OR description ILIKE $1 ESCAPE '\\'
                                  OR variant_label ILIKE $1 ESCAPE '\\')`,
      [pattern]
    );
    const bySlug = new Map<string, Array<ProductRow & { shop_name: string }>>();
    for (const r of rows.rows) bySlug.set(r.shop_slug, [...(bySlug.get(r.shop_slug) ?? []), r]);
    const needle = pattern.slice(1, -1).replace(/\\(.)/g, '$1').toLowerCase();
    const hits: ShopProduct[] = [];
    for (const [, list] of bySlug) {
      for (const p of groupProducts(list, list[0]!.shop_name)) {
        const text = [p.name, p.description ?? '', ...p.variants.map((v) => v.label)]
          .join(' ')
          .toLowerCase();
        if (text.includes(needle)) hits.push(p);
      }
    }
    return hits.slice(0, limit);
  }

  // ── Cliente: contexto ──────────────────────────────────────────────────────
  private consumerTx<T>(
    programTenantId: string,
    consumerId: string,
    fn: (c: PoolClient) => Promise<T>
  ): Promise<T> {
    return withTenantTransaction(this.appPool, programTenantId, async (c) => {
      await c.query(`SELECT set_config('app.consumer_id', $1, true)`, [consumerId]);
      return fn(c);
    });
  }

  async favoriteMerchants(programTenantId: string, consumerId: string): Promise<Set<string>> {
    const r = await this.consumerTx(programTenantId, consumerId, (c) =>
      c.query<{ shop_merchant_id: string }>(
        `SELECT shop_merchant_id FROM consumer_shop_favorites WHERE consumer_id = $1`,
        [consumerId]
      )
    );
    return new Set(r.rows.map((x) => x.shop_merchant_id));
  }

  async setFavorite(
    programTenantId: string,
    consumerId: string,
    slug: string,
    favorite: boolean
  ): Promise<boolean> {
    const v = await this.resolve(slug);
    await this.consumerTx(programTenantId, consumerId, (c) =>
      favorite
        ? c.query(
            `INSERT INTO consumer_shop_favorites
               (tenant_id, consumer_id, shop_tenant_id, shop_merchant_id)
             VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
            [programTenantId, consumerId, v.tenant_id, v.merchant_id]
          )
        : c.query(
            `DELETE FROM consumer_shop_favorites WHERE consumer_id = $1 AND shop_merchant_id = $2`,
            [consumerId, v.merchant_id]
          )
    );
    return favorite;
  }

  // ── Cliente: carrito ───────────────────────────────────────────────────────
  /**
   * Fija la cantidad de un producto (0 = quitar). El precio que se guarda es
   * el VIGENTE del servidor en ese momento (lo que el cliente ve en la ficha).
   */
  async setCartItem(
    programTenantId: string,
    consumerId: string,
    input: { slug: string; productId: string; quantity: number }
  ): Promise<void> {
    if (
      !Number.isInteger(input.quantity) ||
      input.quantity < 0 ||
      input.quantity > SHOP_CART_MAX_QUANTITY
    ) {
      throw new ShopOrderStateError('invalid quantity');
    }
    const v = await this.resolve(input.slug);
    await this.consumerTx(programTenantId, consumerId, async (c) => {
      if (input.quantity === 0) {
        await c.query(
          `DELETE FROM consumer_cart_items WHERE consumer_id = $1 AND product_id = $2`,
          [consumerId, input.productId]
        );
        return;
      }
      const p = await c.query<ProductRow>(
        `SELECT * FROM shop_product_rows() WHERE shop_slug = $1 AND product_id = $2`,
        [input.slug, input.productId]
      );
      const row = p.rows[0];
      if (!row) throw new ShopProductNotFoundError();
      // Un producto base con variantes no se compra solo: hay que elegir una.
      const hasVariants = await c.query(
        `SELECT 1 FROM shop_product_rows() WHERE shop_slug = $1 AND variant_of = $2 LIMIT 1`,
        [input.slug, input.productId]
      );
      if ((hasVariants.rowCount ?? 0) > 0) throw new ShopOrderStateError('choose a variant');
      if (!row.in_stock) throw new ShopOrderStateError('out of stock');
      const count = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM consumer_cart_items
          WHERE consumer_id = $1 AND product_id <> $2`,
        [consumerId, input.productId]
      );
      if ((count.rows[0]?.n ?? 0) >= SHOP_CART_MAX_LINES)
        throw new ShopOrderStateError('cart is full');
      await c.query(
        `INSERT INTO consumer_cart_items
           (tenant_id, consumer_id, shop_tenant_id, shop_merchant_id, product_id, quantity,
            unit_price_seen, currency)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (tenant_id, consumer_id, product_id)
         DO UPDATE SET quantity = EXCLUDED.quantity, unit_price_seen = EXCLUDED.unit_price_seen,
                       currency = EXCLUDED.currency, updated_at = now()`,
        [
          programTenantId,
          consumerId,
          v.tenant_id,
          v.merchant_id,
          input.productId,
          input.quantity,
          row.price,
          row.currency,
        ]
      );
    });
  }

  /**
   * Carrito agrupado por tienda y moneda, revalidado contra el servidor:
   * cambio de precio, producto retirado y falta de existencias se marcan por
   * línea ANTES de pagar.
   */
  async cart(programTenantId: string, consumerId: string): Promise<CartGroup[]> {
    const items = await this.consumerTx(programTenantId, consumerId, (c) =>
      c.query<{
        shop_merchant_id: string;
        product_id: string;
        quantity: number;
        unit_price_seen: string;
        currency: string;
      }>(
        `SELECT shop_merchant_id, product_id, quantity, unit_price_seen::text, btrim(currency) AS currency
           FROM consumer_cart_items WHERE consumer_id = $1 ORDER BY added_at`,
        [consumerId]
      )
    );
    if (!items.rows.length) return [];
    const shops = await this.visible(this.appPool);
    const byMerchant = new Map(shops.map((s) => [s.merchant_id, s]));
    const prows = await this.appPool.query<ProductRow>(
      `SELECT * FROM shop_product_rows() WHERE product_id = ANY($1::uuid[])`,
      [items.rows.map((i) => i.product_id)]
    );
    const live = new Map(prows.rows.map((p) => [p.product_id, p]));
    // Nombres de productos retirados: del catálogo del comercio no hay lectura
    // pública; se muestran como «Producto retirado».
    const groups = new Map<string, CartGroup>();
    for (const it of items.rows) {
      const shop = byMerchant.get(it.shop_merchant_id);
      const p = live.get(it.product_id);
      const key = `${shop?.slug ?? it.shop_merchant_id}|${it.currency}`;
      if (!groups.has(key)) {
        groups.set(key, {
          shopSlug: shop?.slug ?? '',
          shopName: shop?.display_name ?? 'Tienda no disponible',
          currency: it.currency,
          pickup: shop?.pickup ?? false,
          delivery: shop?.delivery ?? false,
          lines: [],
          total: 0n,
          totalSeen: 0n,
          ready: Boolean(shop),
        });
      }
      const g = groups.get(key)!;
      const seen = BigInt(it.unit_price_seen);
      const parentName = p?.variant_of ? (live.get(p.variant_of)?.name ?? null) : null;
      const line: CartLine = {
        productId: it.product_id,
        name: p ? (p.variant_of ? (parentName ?? p.name) : p.name) : 'Producto retirado',
        variantLabel: p?.variant_label ?? null,
        imageRef: p?.image_ref ?? null,
        quantity: it.quantity,
        unitPriceSeen: seen,
        unitPrice: p && p.currency === it.currency ? BigInt(p.price) : null,
        currency: it.currency,
        inStock: p?.in_stock ?? false,
        status:
          !p || p.currency !== it.currency
            ? 'unavailable'
            : !p.in_stock
              ? 'out_of_stock'
              : BigInt(p.price) !== seen
                ? 'price_changed'
                : 'ok',
      };
      g.lines.push(line);
      g.totalSeen += seen * BigInt(it.quantity);
      if (line.unitPrice !== null && (line.status === 'ok' || line.status === 'price_changed')) {
        g.total += line.unitPrice * BigInt(it.quantity);
      }
      if (line.status !== 'ok') g.ready = false;
    }
    // Para variantes, el nombre del producto base sale de la fila del base si
    // está en el carrito; si no, se consulta (lectura pública).
    const missing = [...groups.values()].flatMap((g) => g.lines).filter((l) => l.variantLabel);
    if (missing.length) {
      const bases = await this.appPool.query<{
        product_id: string;
        name: string;
        image_ref: string | null;
      }>(
        `SELECT b.product_id, b.name, b.image_ref FROM shop_product_rows() v
           JOIN shop_product_rows() b ON b.product_id = v.variant_of
          WHERE v.product_id = ANY($1::uuid[])`,
        [missing.map((l) => l.productId)]
      );
      const byVariant = new Map<string, { name: string; image_ref: string | null }>();
      const parent = await this.appPool.query<{ product_id: string; variant_of: string }>(
        `SELECT product_id, variant_of FROM shop_product_rows() WHERE product_id = ANY($1::uuid[])`,
        [missing.map((l) => l.productId)]
      );
      const baseById = new Map(bases.rows.map((b) => [b.product_id, b]));
      for (const p of parent.rows) {
        const b = baseById.get(p.variant_of);
        if (b) byVariant.set(p.product_id, b);
      }
      for (const l of missing) {
        const b = byVariant.get(l.productId);
        if (b) {
          l.name = b.name;
          l.imageRef = l.imageRef ?? b.image_ref;
        }
      }
    }
    return [...groups.values()];
  }

  // ── Cliente: pedidos ───────────────────────────────────────────────────────
  /**
   * Crea el pedido de UNA tienda y moneda con las líneas del carrito.
   *
   *  - Idempotente: la misma clave devuelve el mismo pedido (UNIQUE de la
   *    solicitud, en la MISMA transacción que el pedido).
   *  - `expectedTotal` = total que el cliente revisó: si el servidor calcula
   *    otro, 409 sin crear nada (regla de OrderService).
   *  - Existencias: la reserva del pedido falla si no alcanzan (409).
   *  - Las líneas compradas salen del carrito; el resto queda.
   */
  async createOrder(
    programTenantId: string,
    consumer: { id: string; email: string; displayName: string },
    input: {
      slug: string;
      currency: string;
      expectedTotal: bigint;
      fulfillment: 'pickup' | 'delivery';
      deliveryAddress?: string | null;
      idempotencyKey: string;
    }
  ): Promise<{ order: ShopOrderView; replayed: boolean }> {
    const v = await this.resolve(input.slug);
    const hash = requestHash(consumer.id, input.idempotencyKey);
    const existing = await withTenantTransaction(this.appPool, v.tenant_id, (c) =>
      c.query<{ order_id: string }>(
        `SELECT order_id FROM shop_order_requests WHERE request_hash = $1`,
        [hash]
      )
    );
    if (existing.rows[0]) {
      await this.linkOrder(programTenantId, consumer.id, v, existing.rows[0].order_id);
      return {
        order: await this.getOrder(programTenantId, consumer.id, existing.rows[0].order_id),
        replayed: true,
      };
    }
    if (input.fulfillment === 'pickup' && !v.pickup) throw new ShopFulfillmentError();
    if (input.fulfillment === 'delivery' && !v.delivery) throw new ShopFulfillmentError();
    const address = input.fulfillment === 'delivery' ? input.deliveryAddress?.trim() || null : null;
    if (input.fulfillment === 'delivery' && !address) {
      throw new ShopFulfillmentError('A delivery address is required');
    }

    const cart = await this.consumerTx(programTenantId, consumer.id, (c) =>
      c.query<{ product_id: string; quantity: number; currency: string }>(
        `SELECT product_id, quantity, btrim(currency) AS currency FROM consumer_cart_items
          WHERE consumer_id = $1 AND shop_merchant_id = $2 ORDER BY added_at`,
        [consumer.id, v.merchant_id]
      )
    );
    const lines = cart.rows.filter((r) => r.currency === input.currency);
    if (!lines.length) throw new ShopCartEmptyError();

    let orderId: string;
    try {
      orderId = await withTenantTransaction(this.appPool, v.tenant_id, async (c) => {
        // Solo productos PUBLICADOS de esta tienda (no cualquier id del catálogo).
        const pub = await c.query<{ product_id: string }>(
          `SELECT product_id FROM shop_product_rows() WHERE shop_slug = $1 AND product_id = ANY($2::uuid[])`,
          [v.slug, lines.map((l) => l.product_id)]
        );
        const published = new Set(pub.rows.map((r) => r.product_id));
        const gone = lines.find((l) => !published.has(l.product_id));
        if (gone) throw new ShopProductNotFoundError();
        const order = await this.orders.createIn(c, v.tenant_id, {
          merchantId: v.merchant_id,
          currency: input.currency,
          lines: lines.map((l) => ({ productId: l.product_id, quantity: l.quantity })),
          expectedTotal: input.expectedTotal,
          note: `Pedido en línea (Fluvia Tiendas) · ${input.fulfillment === 'pickup' ? 'Retiro en tienda' : 'Entrega'}`,
        });
        await c.query(
          `INSERT INTO shop_order_requests
             (tenant_id, order_id, request_hash, program_tenant_id, consumer_id, buyer_name,
              buyer_email, fulfillment, delivery_address)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            v.tenant_id,
            order.id,
            hash,
            programTenantId,
            consumer.id,
            consumer.displayName.slice(0, 80),
            consumer.email,
            input.fulfillment,
            address,
          ]
        );
        return order.id;
      });
    } catch (err) {
      // Dos envíos simultáneos con la misma clave: el segundo ve el UNIQUE y
      // devuelve el pedido del primero (sin pedido ni reserva duplicados).
      if ((err as { constraint?: string }).constraint === 'shop_order_requests_hash_uniq') {
        return this.createOrder(programTenantId, consumer, input);
      }
      throw err;
    }
    await this.linkOrder(programTenantId, consumer.id, v, orderId);
    await this.consumerTx(programTenantId, consumer.id, (c) =>
      c.query(
        `DELETE FROM consumer_cart_items
          WHERE consumer_id = $1 AND shop_merchant_id = $2 AND btrim(currency) = $3
            AND product_id = ANY($4::uuid[])`,
        [consumer.id, v.merchant_id, input.currency, lines.map((l) => l.product_id)]
      )
    );
    return { order: await this.getOrder(programTenantId, consumer.id, orderId), replayed: false };
  }

  private async linkOrder(
    programTenantId: string,
    consumerId: string,
    v: Pick<VisibleRow, 'tenant_id' | 'merchant_id'>,
    orderId: string
  ): Promise<void> {
    await this.consumerTx(programTenantId, consumerId, (c) =>
      c.query(
        `INSERT INTO consumer_shop_orders
           (tenant_id, consumer_id, shop_tenant_id, shop_merchant_id, order_id)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
        [programTenantId, consumerId, v.tenant_id, v.merchant_id, orderId]
      )
    );
  }

  /** Pedido propio. Ajeno o inexistente ⇒ 404 indistinguible. */
  private async ownRef(
    programTenantId: string,
    consumerId: string,
    orderId: string
  ): Promise<{ shop_tenant_id: string; shop_merchant_id: string }> {
    const r = await this.consumerTx(programTenantId, consumerId, (c) =>
      c.query<{ shop_tenant_id: string; shop_merchant_id: string }>(
        `SELECT shop_tenant_id, shop_merchant_id FROM consumer_shop_orders
          WHERE consumer_id = $1 AND order_id = $2`,
        [consumerId, orderId]
      )
    );
    if (!r.rows[0]) throw new ShopOrderStateError('not found');
    return r.rows[0];
  }

  async getOrder(
    programTenantId: string,
    consumerId: string,
    orderId: string
  ): Promise<ShopOrderView> {
    let ref;
    try {
      ref = await this.ownRef(programTenantId, consumerId, orderId);
    } catch {
      throw new ShopNotFoundError();
    }
    return withTenantTransaction(this.appPool, ref.shop_tenant_id, async (c) => {
      const req = await c.query<{
        consumer_id: string;
        fulfillment: 'pickup' | 'delivery';
        delivery_address: string | null;
        fulfillment_status: ShopFulfillmentStatus;
        return_requested_at: Date | null;
        return_reason: string | null;
      }>(`SELECT * FROM shop_order_requests WHERE order_id = $1`, [orderId]);
      const rq = req.rows[0];
      if (!rq || rq.consumer_id !== consumerId) throw new ShopNotFoundError();
      const o = await this.orders.getIn(c, orderId);
      const slug = await c.query<{ slug: string; display_name: string }>(
        `SELECT slug, display_name FROM merchant_directory_profiles WHERE merchant_id = $1`,
        [ref.shop_merchant_id]
      );
      return {
        orderId: o.id,
        shopSlug: slug.rows[0]?.slug ?? null,
        shopName: slug.rows[0]?.display_name ?? o.merchantName ?? 'Tienda',
        number: o.number,
        createdAt: o.createdAt,
        currency: o.currency,
        total: o.total,
        lines: o.lines,
        payment: o.payment,
        installments: o.installments,
        cancellation: o.cancellation,
        fulfillment: rq.fulfillment,
        deliveryAddress: rq.delivery_address,
        fulfillmentStatus: rq.fulfillment_status,
        returnRequestedAt: rq.return_requested_at?.toISOString() ?? null,
        returnReason: rq.return_reason,
        paymentLinkId: o.paymentLinkId,
      };
    });
  }

  async listOrders(
    programTenantId: string,
    consumerId: string,
    limit = 30
  ): Promise<ShopOrderView[]> {
    const refs = await this.consumerTx(programTenantId, consumerId, (c) =>
      c.query<{ order_id: string }>(
        `SELECT order_id FROM consumer_shop_orders WHERE consumer_id = $1
          ORDER BY created_at DESC LIMIT $2`,
        [consumerId, limit]
      )
    );
    const out: ShopOrderView[] = [];
    for (const r of refs.rows)
      out.push(await this.getOrder(programTenantId, consumerId, r.order_id));
    return out;
  }

  /** El cliente anula un pedido SIN cobro: libera la reserva (OrderService.cancel). */
  async cancelOrder(
    programTenantId: string,
    consumerId: string,
    orderId: string
  ): Promise<ShopOrderView> {
    const view = await this.getOrder(programTenantId, consumerId, orderId);
    if (view.payment.state === 'cancelled') return view;
    if (view.payment.state !== 'awaiting_payment') {
      throw new ShopOrderStateError('order has a payment in progress or charged');
    }
    const ref = await this.ownRef(programTenantId, consumerId, orderId);
    await this.orders.cancel(ref.shop_tenant_id, orderId, {
      reason: 'Anulado por el cliente (Fluvia Tiendas)',
    });
    await withTenantTransaction(this.appPool, ref.shop_tenant_id, (c) =>
      c.query(
        `UPDATE shop_order_requests SET fulfillment_status = 'cancelled'
          WHERE order_id = $1 AND fulfillment_status NOT IN ('delivered', 'cancelled')`,
        [orderId]
      )
    );
    return this.getOrder(programTenantId, consumerId, orderId);
  }

  /**
   * Solicitud de devolución: queda registrada para el comercio, que la
   * resuelve con el flujo de devoluciones EXISTENTE (reembolso del cobro).
   * Solo sobre un pedido cobrado; una sola vez.
   */
  async requestReturn(
    programTenantId: string,
    consumerId: string,
    orderId: string,
    reason: string
  ): Promise<ShopOrderView> {
    const view = await this.getOrder(programTenantId, consumerId, orderId);
    if (view.payment.state !== 'paid' && view.payment.state !== 'partially_refunded') {
      throw new ShopOrderStateError('only a charged order can be returned');
    }
    if (view.returnRequestedAt) return view;
    const ref = await this.ownRef(programTenantId, consumerId, orderId);
    await withTenantTransaction(this.appPool, ref.shop_tenant_id, (c) =>
      c.query(
        `UPDATE shop_order_requests SET return_requested_at = now(), return_reason = $2
          WHERE order_id = $1 AND return_requested_at IS NULL`,
        [orderId, reason.trim().slice(0, 280)]
      )
    );
    return this.getOrder(programTenantId, consumerId, orderId);
  }

  // ── Comercio ───────────────────────────────────────────────────────────────
  async adminView(tenantId: string, merchantId: string): Promise<ShopAdminView> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const s = await c.query(`SELECT * FROM shop_settings WHERE merchant_id = $1`, [merchantId]);
      const d = await c.query<{ slug: string; display_name: string; visibility: string }>(
        `SELECT slug, display_name, visibility FROM merchant_directory_profiles WHERE merchant_id = $1`,
        [merchantId]
      );
      const l = await c.query<{
        id: string;
        name: string;
        price: string;
        currency: string;
        image_ref: string | null;
        available: boolean;
        listed: boolean;
        visible: boolean | null;
        featured: boolean | null;
        collection: string | null;
        position: number | null;
        variant_count: number;
      }>(
        `SELECT p.id, p.name, p.price::text, btrim(p.currency) AS currency, p.image_ref, p.available,
                (sl.product_id IS NOT NULL) AS listed, sl.visible, sl.featured, sl.collection,
                sl.position,
                (SELECT count(*)::int FROM catalog_products v
                  WHERE v.variant_of = p.id AND v.archived_at IS NULL) AS variant_count
           FROM catalog_products p
           LEFT JOIN shop_listings sl ON sl.product_id = p.id
          WHERE p.archived_at IS NULL AND p.variant_of IS NULL
          ORDER BY (sl.product_id IS NULL), sl.position NULLS LAST, p.name`
      );
      return {
        settings: s.rows[0] ? toSettings(s.rows[0]) : null,
        directory: d.rows[0]
          ? {
              slug: d.rows[0].slug,
              displayName: d.rows[0].display_name,
              visibility: d.rows[0].visibility,
            }
          : null,
        listings: l.rows.map((r) => ({
          productId: r.id,
          name: r.name,
          price: BigInt(r.price),
          currency: r.currency,
          imageRef: r.image_ref,
          available: r.available,
          listed: r.listed,
          visible: r.visible ?? false,
          featured: r.featured ?? false,
          collection: r.collection,
          position: r.position ?? 0,
          variantCount: r.variant_count,
        })),
      };
    });
  }

  async upsertSettings(
    tenantId: string,
    merchantId: string,
    input: Omit<ShopSettingsDto, 'merchantId' | 'version'> & { expectedVersion: number }
  ): Promise<ShopSettingsDto> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      if (input.enabled) {
        const d = await c.query<{ visibility: string }>(
          `SELECT visibility FROM merchant_directory_profiles WHERE merchant_id = $1`,
          [merchantId]
        );
        if (d.rows[0]?.visibility !== 'published') throw new ShopNotPublishableError();
      }
      const vals = [
        input.enabled,
        input.pickup,
        input.delivery,
        input.deliveryTerms,
        input.returnsPolicy,
        input.contactEmail,
        input.contactPhone,
        input.bannerRef,
      ];
      try {
        if (input.expectedVersion === 0) {
          const r = await c.query(
            `INSERT INTO shop_settings
               (tenant_id, merchant_id, enabled, pickup, delivery, delivery_terms, returns_policy,
                contact_email, contact_phone, banner_ref)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (tenant_id, merchant_id) DO NOTHING RETURNING *`,
            [tenantId, merchantId, ...vals]
          );
          if (!r.rows[0]) throw new ShopVersionConflictError();
          return toSettings(r.rows[0]);
        }
        const r = await c.query(
          `UPDATE shop_settings SET enabled = $3, pickup = $4, delivery = $5, delivery_terms = $6,
                  returns_policy = $7, contact_email = $8, contact_phone = $9, banner_ref = $10,
                  version = version + 1, updated_at = now()
            WHERE merchant_id = $1 AND version = $2 RETURNING *`,
          [merchantId, input.expectedVersion, ...vals]
        );
        if (!r.rows[0]) throw new ShopVersionConflictError();
        return toSettings(r.rows[0]);
      } catch (err) {
        if (isCheckViolation(err, 'shop_settings_fulfillment_chk'))
          throw new ShopFulfillmentError('Offer pickup, delivery or both');
        throw err;
      }
    });
  }

  async setListing(
    tenantId: string,
    productId: string,
    input: { visible: boolean; featured: boolean; collection: string | null; position: number }
  ): Promise<void> {
    await withTenantTransaction(this.appPool, tenantId, async (c) => {
      const p = await c.query<{ variant_of: string | null }>(
        `SELECT variant_of FROM catalog_products WHERE id = $1 AND archived_at IS NULL`,
        [productId]
      );
      if (!p.rows[0]) throw new ShopProductNotFoundError();
      // Se publica el producto BASE; sus variantes lo acompañan.
      if (p.rows[0].variant_of) throw new ShopOrderStateError('publish the base product');
      await c.query(
        `INSERT INTO shop_listings (tenant_id, product_id, visible, featured, collection, position)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, product_id) DO UPDATE SET visible = EXCLUDED.visible,
           featured = EXCLUDED.featured, collection = EXCLUDED.collection,
           position = EXCLUDED.position, updated_at = now()`,
        [
          tenantId,
          productId,
          input.visible,
          input.featured,
          input.collection?.trim() || null,
          input.position,
        ]
      );
    });
  }

  async adminOrders(tenantId: string, limit = 50): Promise<ShopAdminOrder[]> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const rows = await c.query<{ order_id: string }>(
        `SELECT order_id FROM shop_order_requests ORDER BY created_at DESC LIMIT $1`,
        [limit]
      );
      const out: ShopAdminOrder[] = [];
      for (const r of rows.rows) out.push(await this.adminOrderIn(c, r.order_id));
      return out;
    });
  }

  private async adminOrderIn(c: PoolClient, orderId: string): Promise<ShopAdminOrder> {
    const rq = await c.query<{
      buyer_name: string;
      buyer_email: string;
      fulfillment: 'pickup' | 'delivery';
      delivery_address: string | null;
      fulfillment_status: ShopFulfillmentStatus;
      return_requested_at: Date | null;
      return_reason: string | null;
    }>(`SELECT * FROM shop_order_requests WHERE order_id = $1`, [orderId]);
    if (!rq.rows[0]) throw new ShopNotFoundError();
    const o = await this.orders.getIn(c, orderId);
    const r = rq.rows[0];
    return {
      orderId,
      number: o.number,
      createdAt: o.createdAt,
      currency: o.currency,
      total: o.total,
      paymentState: o.payment.state,
      buyerName: r.buyer_name,
      buyerEmail: r.buyer_email,
      fulfillment: r.fulfillment,
      deliveryAddress: r.delivery_address,
      fulfillmentStatus: r.fulfillment_status,
      returnRequestedAt: r.return_requested_at?.toISOString() ?? null,
      returnReason: r.return_reason,
    };
  }

  /**
   * Avance de la entrega por el comercio. Preparar/entregar exige un pedido
   * COBRADO (estado derivado): nunca se entrega lo que no se cobró.
   */
  async setFulfillment(
    tenantId: string,
    orderId: string,
    status: ShopFulfillmentStatus
  ): Promise<ShopAdminOrder> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const o = await this.orders.getIn(c, orderId);
      if (status === 'cancelled') {
        if (o.payment.state !== 'cancelled') {
          throw new ShopOrderStateError('cancel the sale first (refund if it was charged)');
        }
      } else if (!['paid', 'partially_refunded'].includes(o.payment.state)) {
        throw new ShopOrderStateError('the order is not charged');
      }
      try {
        const r = await c.query(
          `UPDATE shop_order_requests SET fulfillment_status = $2 WHERE order_id = $1`,
          [orderId, status]
        );
        if (!r.rowCount) throw new ShopNotFoundError();
      } catch (err) {
        if (hasEngineMessage(err, 'FLUVIA_SHOP_FULFILLMENT')) {
          throw new ShopOrderStateError('fulfillment step not allowed');
        }
        throw err;
      }
      return this.adminOrderIn(c, orderId);
    });
  }
}

function toSettings(r: Record<string, unknown>): ShopSettingsDto {
  return {
    merchantId: String(r.merchant_id),
    enabled: Boolean(r.enabled),
    pickup: Boolean(r.pickup),
    delivery: Boolean(r.delivery),
    deliveryTerms: (r.delivery_terms as string | null) ?? null,
    returnsPolicy: (r.returns_policy as string | null) ?? null,
    contactEmail: (r.contact_email as string | null) ?? null,
    contactPhone: (r.contact_phone as string | null) ?? null,
    bannerRef: (r.banner_ref as string | null) ?? null,
    version: Number(r.version),
  };
}
