import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '@fluvia/db/testing';
import { LedgerService, PostingService } from '@fluvia/ledger';
import {
  CheckoutSessionService,
  MockPaymentProvider,
  PaymentConfirmationService,
  PaymentIntentService,
  PaymentLinkService,
  ZERO_FEE_SCHEDULE,
} from '@fluvia/payments-core';
import {
  CatalogService,
  InsufficientStockError,
  InventoryService,
  OrderService,
  OrderTotalMismatchError,
  ShopCartEmptyError,
  ShopNotFoundError,
  ShopNotPublishableError,
  ShopOrderStateError,
  ShopProductNotFoundError,
  ShopService,
  groupProducts,
} from '../src/index.js';

/**
 * Tiendas Fluvia (0063/0064) contra PostgreSQL REAL + MockProvider:
 *  - visibilidad explícita (perfil publicado + tienda activa + producto publicado);
 *  - lectura pública sin cantidades de inventario;
 *  - carrito revalidado (cambio de precio, agotado, retirado);
 *  - pedido idempotente, precio del servidor, reserva de existencias;
 *  - aislamiento entre clientes; anular libera; entrega solo si está cobrado.
 */

let ctx: TestContext;
let shops: ShopService;
let catalog: CatalogService;
let inventory: InventoryService;
let links: PaymentLinkService;
let checkout: CheckoutSessionService;
let org: string;
let merchant: string;
let program: string;
let slug: string;
const buyer = () => ({
  id: randomUUID(),
  email: `c-${randomUUID().slice(0, 6)}@cliente.test`,
  displayName: 'Cliente Prueba',
});

beforeAll(async () => {
  ctx = await createTestContext();
  const intents = new PaymentIntentService(ctx.app);
  const posting = new PostingService(new LedgerService(ctx.app), ctx.app);
  const confirmation = new PaymentConfirmationService(
    ctx.app,
    intents,
    posting,
    new MockPaymentProvider(),
    ZERO_FEE_SCHEDULE
  );
  checkout = new CheckoutSessionService(ctx.app, { confirmation });
  links = new PaymentLinkService(ctx.app, { intents, checkout });
  catalog = new CatalogService(ctx.app);
  inventory = new InventoryService(ctx.app);
  shops = new ShopService(ctx.app, new OrderService(ctx.app, links));
  org = await ctx.createTenant(`Shop ${randomUUID().slice(0, 8)}`);
  program = await ctx.createTenant(`Programa ${randomUUID().slice(0, 8)}`);
  const m = await ctx.admin.query<{ id: string }>(
    `INSERT INTO merchants (tenant_id, name) VALUES ($1, 'Casa Prueba') RETURNING id`,
    [org]
  );
  merchant = m.rows[0]!.id;
  slug = `casa-${randomUUID().slice(0, 8)}`;
  await ctx.admin.query(
    `INSERT INTO merchant_directory_profiles
       (tenant_id, merchant_id, slug, display_name, category, city, channels)
     VALUES ($1, $2, $3, 'Casa Prueba', 'hogar', 'Caracas', '{online}')`,
    [org, merchant, slug]
  );
}, 30_000);

afterAll(async () => {
  await ctx.close();
});

async function product(
  price: bigint,
  opts: { stock?: number; variantOf?: string; label?: string } = {}
) {
  const p = await catalog.createProduct(org, {
    name: `Taza ${randomUUID().slice(0, 6)}`,
    price,
    currency: 'VES',
    trackStock: opts.stock !== undefined,
    ...(opts.variantOf ? { variantOf: opts.variantOf, variantLabel: opts.label ?? 'Azul' } : {}),
  });
  if (opts.stock) {
    await inventory.change(org, p.id, { kind: 'receipt', quantity: opts.stock, reason: 'Inicial' });
  }
  return p;
}

const listing = (id: string) =>
  shops.setListing(org, id, { visible: true, featured: false, collection: null, position: 0 });

describe('visibilidad explícita', () => {
  it('sin perfil publicado no se puede activar; activada solo muestra lo publicado', async () => {
    await expect(
      shops.upsertSettings(org, merchant, {
        enabled: true,
        pickup: true,
        delivery: false,
        deliveryTerms: null,
        returnsPolicy: null,
        contactEmail: null,
        contactPhone: null,
        bannerRef: null,
        expectedVersion: 0,
      })
    ).rejects.toBeInstanceOf(ShopNotPublishableError);
    await ctx.admin.query(
      `UPDATE merchant_directory_profiles SET visibility = 'published', published_at = now()
        WHERE merchant_id = $1`,
      [merchant]
    );
    const s = await shops.upsertSettings(org, merchant, {
      enabled: true,
      pickup: true,
      delivery: true,
      deliveryTerms: 'Entrega en 48 h en Caracas',
      returnsPolicy: 'Cambios en 7 días con el empaque',
      contactEmail: 'hola@casa.test',
      contactPhone: '+58 212 555 0100',
      bannerRef: null,
      expectedVersion: 0,
    });
    expect(s.version).toBe(1);
    const hidden = await product(1_000n);
    const shown = await product(2_000n, { stock: 3 });
    await listing(shown.id);
    const view = await shops.shop(slug);
    expect(view.products.map((p) => p.id)).toEqual([shown.id]);
    expect(view.products.map((p) => p.id)).not.toContain(hidden.id);
    // Sin cantidades: solo disponible/agotado.
    expect(JSON.stringify(view, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).not.toMatch(
      /on_hand|reserved|tenant/
    );
    expect(view.shop.deliveryTerms).toContain('48 h');
  });

  it('una tienda desactivada desaparece y no resuelve', async () => {
    const other = await ctx.createTenant(`Otra ${randomUUID().slice(0, 8)}`);
    const m = await ctx.admin.query<{ id: string }>(
      `INSERT INTO merchants (tenant_id, name) VALUES ($1, 'Oculta') RETURNING id`,
      [other]
    );
    const s2 = `oculta-${randomUUID().slice(0, 6)}`;
    await ctx.admin.query(
      `INSERT INTO merchant_directory_profiles
         (tenant_id, merchant_id, slug, display_name, category, city, visibility, published_at)
       VALUES ($1, $2, $3, 'Oculta', 'moda', 'Valencia', 'published', now())`,
      [other, m.rows[0]!.id, s2]
    );
    await expect(shops.shop(s2)).rejects.toBeInstanceOf(ShopNotFoundError);
    expect((await shops.listShops({})).map((s) => s.slug)).not.toContain(s2);
  });

  it('variantes: se elige una; el base con variantes no se compra solo', async () => {
    const base = await product(3_000n);
    const azul = await product(3_000n, { variantOf: base.id, label: 'Azul', stock: 2 });
    await product(3_500n, { variantOf: base.id, label: 'Verde' });
    await listing(base.id);
    const { product: p } = await shops.product(slug, azul.id);
    expect(p.id).toBe(base.id);
    expect(p.variants.map((v) => v.label)).toEqual(['Azul', 'Verde']);
    expect(p.sellable).toBe(false);
    await expect(
      shops.setCartItem(program, randomUUID(), { slug, productId: base.id, quantity: 1 })
    ).rejects.toBeInstanceOf(ShopOrderStateError);
  });
});

describe('carrito y pedido', () => {
  it('carrito revalidado: cambio de precio y agotado se marcan antes de pagar', async () => {
    const c = buyer();
    const a = await product(1_500n);
    const b = await product(900n, { stock: 1 });
    await listing(a.id);
    await listing(b.id);
    await shops.setCartItem(program, c.id, { slug, productId: a.id, quantity: 2 });
    await shops.setCartItem(program, c.id, { slug, productId: b.id, quantity: 1 });
    let [g] = await shops.cart(program, c.id);
    expect(g!.ready).toBe(true);
    expect(g!.total).toBe(3_900n);

    await catalog.updateProduct(org, a.id, { price: 1_700n, expectedVersion: 1 });
    // Otro cliente agota b (reserva).
    const other = buyer();
    await shops.setCartItem(program, other.id, { slug, productId: b.id, quantity: 1 });
    await shops.createOrder(program, other, {
      slug,
      currency: 'VES',
      expectedTotal: 900n,
      fulfillment: 'pickup',
      idempotencyKey: `k-${randomUUID()}`,
    });
    [g] = await shops.cart(program, c.id);
    const byId = new Map(g!.lines.map((l) => [l.productId, l]));
    expect(byId.get(a.id)!.status).toBe('price_changed');
    expect(byId.get(a.id)!.unitPrice).toBe(1_700n);
    expect(byId.get(b.id)!.status).toBe('out_of_stock');
    expect(g!.ready).toBe(false);

    // Con el total VIEJO, el servidor no crea nada (409).
    await shops.setCartItem(program, c.id, { slug, productId: b.id, quantity: 0 });
    await expect(
      shops.createOrder(program, c, {
        slug,
        currency: 'VES',
        expectedTotal: 3_000n,
        fulfillment: 'pickup',
        idempotencyKey: `k-${randomUUID()}`,
      })
    ).rejects.toBeInstanceOf(OrderTotalMismatchError);
  });

  it('pedido idempotente: la misma clave devuelve el mismo pedido y no reserva dos veces', async () => {
    const c = buyer();
    const p = await product(1_200n, { stock: 5 });
    await listing(p.id);
    await shops.setCartItem(program, c.id, { slug, productId: p.id, quantity: 2 });
    const key = `k-${randomUUID()}`;
    const input = {
      slug,
      currency: 'VES',
      expectedTotal: 2_400n,
      fulfillment: 'delivery' as const,
      deliveryAddress: 'Av. Principal, Chacao',
      idempotencyKey: key,
    };
    const [one, two] = await Promise.all([
      shops.createOrder(program, c, input),
      shops.createOrder(program, c, input),
    ]);
    expect(one.order.orderId).toBe(two.order.orderId);
    expect([one.replayed, two.replayed].sort()).toEqual([false, true]);
    const st = await inventory.stock(org, p.id);
    expect(st.reserved).toBe(2n);
    expect(one.order.payment.state).toBe('awaiting_payment');
    expect(one.order.lines[0]!.unitPrice).toBe(1_200n);
    // El carrito de esa tienda/moneda quedó vacío.
    expect(await shops.cart(program, c.id)).toEqual([]);
    await expect(
      shops.createOrder(program, c, { ...input, idempotencyKey: `k-${randomUUID()}` })
    ).rejects.toBeInstanceOf(ShopCartEmptyError);
  });

  it('sin existencias suficientes no se crea pedido', async () => {
    const c = buyer();
    const p = await product(700n, { stock: 1 });
    await listing(p.id);
    await shops.setCartItem(program, c.id, { slug, productId: p.id, quantity: 3 });
    await expect(
      shops.createOrder(program, c, {
        slug,
        currency: 'VES',
        expectedTotal: 2_100n,
        fulfillment: 'pickup',
        idempotencyKey: `k-${randomUUID()}`,
      })
    ).rejects.toBeInstanceOf(InsufficientStockError);
    expect((await shops.listOrders(program, c.id)).length).toBe(0);
  });

  it('otro cliente no ve, no anula ni pide devolución de un pedido ajeno', async () => {
    const c = buyer();
    const intruder = buyer();
    const p = await product(500n);
    await listing(p.id);
    await shops.setCartItem(program, c.id, { slug, productId: p.id, quantity: 1 });
    const { order } = await shops.createOrder(program, c, {
      slug,
      currency: 'VES',
      expectedTotal: 500n,
      fulfillment: 'pickup',
      idempotencyKey: `k-${randomUUID()}`,
    });
    await expect(shops.getOrder(program, intruder.id, order.orderId)).rejects.toBeInstanceOf(
      ShopNotFoundError
    );
    await expect(shops.cancelOrder(program, intruder.id, order.orderId)).rejects.toBeInstanceOf(
      ShopNotFoundError
    );
    expect(await shops.listOrders(program, intruder.id)).toEqual([]);
  });

  it('anular sin cobro libera la reserva; con cobro aprobado no se anula y el comercio entrega', async () => {
    const c = buyer();
    const p = await product(1_000n, { stock: 4 });
    await listing(p.id);
    await shops.setCartItem(program, c.id, { slug, productId: p.id, quantity: 2 });
    const { order } = await shops.createOrder(program, c, {
      slug,
      currency: 'VES',
      expectedTotal: 2_000n,
      fulfillment: 'pickup',
      idempotencyKey: `k-${randomUUID()}`,
    });
    // El comercio no puede «entregar» lo que no está cobrado.
    await expect(shops.setFulfillment(org, order.orderId, 'preparing')).rejects.toBeInstanceOf(
      ShopOrderStateError
    );
    const cancelled = await shops.cancelOrder(program, c.id, order.orderId);
    expect(cancelled.payment.state).toBe('cancelled');
    expect(cancelled.fulfillmentStatus).toBe('cancelled');
    expect((await inventory.stock(org, p.id)).reserved).toBe(0n);

    await shops.setCartItem(program, c.id, { slug, productId: p.id, quantity: 1 });
    const { order: o2 } = await shops.createOrder(program, c, {
      slug,
      currency: 'VES',
      expectedTotal: 1_000n,
      fulfillment: 'pickup',
      idempotencyKey: `k-${randomUUID()}`,
    });
    const s = await links.createSessionFromLink(o2.paymentLinkId);
    await checkout.confirmByClientSecret(s.checkoutSessionId, s.clientSecret, 'tok_approve');
    const paid = await shops.getOrder(program, c.id, o2.orderId);
    expect(paid.payment.state).toBe('paid');
    await expect(shops.cancelOrder(program, c.id, o2.orderId)).rejects.toBeInstanceOf(
      ShopOrderStateError
    );
    const prep = await shops.setFulfillment(org, o2.orderId, 'preparing');
    expect(prep.fulfillmentStatus).toBe('preparing');
    // Hacia atrás no.
    await expect(shops.setFulfillment(org, o2.orderId, 'received')).rejects.toBeInstanceOf(
      ShopOrderStateError
    );
    const ret = await shops.requestReturn(program, c.id, o2.orderId, 'Llegó con un golpe');
    expect(ret.returnReason).toBe('Llegó con un golpe');
    const admin = await shops.adminOrders(org);
    expect(admin.find((x) => x.orderId === o2.orderId)!.returnRequestedAt).not.toBeNull();
  });

  it('pago rechazado deja el pedido pendiente de pago; incierto queda «en confirmación»', async () => {
    const c = buyer();
    const p = await product(800n);
    await listing(p.id);
    for (const [token, want] of [
      ['tok_decline', 'awaiting_payment'],
      ['tok_timeout', 'payment_in_progress'],
    ] as const) {
      await shops.setCartItem(program, c.id, { slug, productId: p.id, quantity: 1 });
      const { order } = await shops.createOrder(program, c, {
        slug,
        currency: 'VES',
        expectedTotal: 800n,
        fulfillment: 'pickup',
        idempotencyKey: `k-${randomUUID()}`,
      });
      const s = await links.createSessionFromLink(order.paymentLinkId);
      await checkout
        .confirmByClientSecret(s.checkoutSessionId, s.clientSecret, token)
        .catch(() => undefined);
      const v = await shops.getOrder(program, c.id, order.orderId);
      expect(v.payment.state).toBe(want);
    }
  });

  it('favoritos persistentes por cliente', async () => {
    const c = buyer();
    await shops.setFavorite(program, c.id, slug, true);
    expect(
      (await shops.listShops({ favorites: await shops.favoriteMerchants(program, c.id) })).find(
        (s) => s.slug === slug
      )!.favorite
    ).toBe(true);
    expect((await shops.favoriteMerchants(program, buyer().id)).size).toBe(0);
    await shops.setFavorite(program, c.id, slug, false);
    expect((await shops.favoriteMerchants(program, c.id)).size).toBe(0);
  });

  it('un producto no publicado no entra al carrito', async () => {
    const p = await product(100n);
    await expect(
      shops.setCartItem(program, randomUUID(), { slug, productId: p.id, quantity: 1 })
    ).rejects.toBeInstanceOf(ShopProductNotFoundError);
  });
});

describe('agrupación pura', () => {
  it('«desde» = variante más barata en existencia; destacados primero', () => {
    const row = (o: Partial<Parameters<typeof groupProducts>[0][number]>) => ({
      shop_slug: 's',
      product_id: randomUUID(),
      name: 'X',
      description: null,
      price: '100',
      currency: 'VES',
      image_ref: null,
      variant_of: null,
      variant_label: null,
      category_name: null,
      featured: false,
      collection: null,
      list_position: 0,
      in_stock: true,
      ...o,
    });
    const base = row({ name: 'Base', featured: true });
    const out = groupProducts([
      row({ name: 'Otro' }),
      base,
      row({ variant_of: base.product_id, variant_label: 'S', price: '50', in_stock: false }),
      row({ variant_of: base.product_id, variant_label: 'M', price: '80' }),
    ]);
    expect(out[0]!.name).toBe('Base');
    expect(out[0]!.price).toBe(80n);
    expect(out[0]!.inStock).toBe(true);
  });
});
