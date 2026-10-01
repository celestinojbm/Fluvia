import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenantTransaction } from '@fluvia/db';
import { createTestContext, type TestContext } from '@fluvia/db/testing';
import { LedgerService, PostingService } from '@fluvia/ledger';
import { Money } from '@fluvia/money';
import {
  CheckoutSessionService,
  MockPaymentProvider,
  PaymentConfirmationService,
  PaymentIntentService,
  PaymentLinkService,
  RefundService,
  ZERO_FEE_SCHEDULE,
} from '@fluvia/payments-core';
import {
  CatalogService,
  CatalogVariantError,
  InstallmentSandboxService,
  InsufficientStockError,
  InventoryConflictError,
  InventoryService,
  OrderNotCancellableError,
  OrderService,
  StockNotTrackedError,
  UnknownImageError,
  isOrderCancelled,
} from '../src/index.js';

/**
 * Existencias, variantes, imágenes y anulación (0051) contra PostgreSQL REAL +
 * MockProvider. Reglas bajo prueba:
 *  - reserva al registrar la venta; descuento SOLO con cobro confirmado;
 *  - un rechazo o un resultado incierto NO liberan; solo anular libera;
 *  - anular se rechaza si un cobro retiene la venta; tras anular, ningún
 *    checkout de la venta cobra;
 *  - los niveles solo los mueve el motor.
 */

let ctx: TestContext;
let catalog: CatalogService;
let orders: OrderService;
let inventory: InventoryService;
let installments: InstallmentSandboxService;
let links: PaymentLinkService;
let checkout: CheckoutSessionService;
let intents: PaymentIntentService;
let posting: PostingService;
let refunds: RefundService;
let org: string;
let orgB: string;
let merchant: string;

beforeAll(async () => {
  ctx = await createTestContext();
  intents = new PaymentIntentService(ctx.app);
  posting = new PostingService(new LedgerService(ctx.app), ctx.app);
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
  orders = new OrderService(ctx.app, links);
  inventory = new InventoryService(ctx.app);
  installments = new InstallmentSandboxService(ctx.app, orders);
  refunds = new RefundService(ctx.app, intents, posting, new MockPaymentProvider());
  org = await ctx.createTenant(`Stock ${randomUUID().slice(0, 8)}`);
  orgB = await ctx.createTenant(`Stock-B ${randomUUID().slice(0, 8)}`);
  const m = await ctx.admin.query<{ id: string }>(
    `INSERT INTO merchants (tenant_id, name) VALUES ($1, 'Tienda') RETURNING id`,
    [org]
  );
  merchant = m.rows[0]!.id;
}, 30_000);

afterAll(async () => {
  await ctx.close();
});

const sku = () => `INV-${randomUUID().slice(0, 8)}`;

async function tracked(price: bigint, initial: number) {
  const p = await catalog.createProduct(org, {
    name: `Prod ${randomUUID().slice(0, 6)}`,
    sku: sku(),
    price,
    currency: 'VES',
    trackStock: true,
  });
  if (initial > 0) {
    await inventory.change(org, p.id, {
      kind: 'receipt',
      quantity: initial,
      reason: 'Inventario inicial',
    });
  }
  return p;
}

async function sell(productId: string, quantity: number, unit: bigint) {
  return withTenantTransaction(ctx.app, org, (c) =>
    orders.createIn(c, org, {
      merchantId: merchant,
      currency: 'VES',
      lines: [{ productId, quantity }],
      expectedTotal: unit * BigInt(quantity),
    })
  );
}

async function level(productId: string) {
  const s = await inventory.stock(org, productId);
  return { onHand: s.onHand, reserved: s.reserved, free: s.free };
}

async function pay(paymentLinkId: string, token: string) {
  const s = await links.createSessionFromLink(paymentLinkId);
  try {
    await checkout.confirmByClientSecret(s.checkoutSessionId, s.clientSecret, token);
  } catch {
    // tok_timeout: desenlace desconocido (el intent queda reteniendo la venta)
  }
  return s;
}

describe('entradas y ajustes del comercio', () => {
  it('entrada, merma y corrección; no por debajo de lo reservado; sin control ⇒ rechazado', async () => {
    const p = await tracked(1_000n, 10);
    expect(await level(p.id)).toEqual({ onHand: 10n, reserved: 0n, free: 10n });
    await inventory.change(org, p.id, { kind: 'adjustment', quantity: -3, reason: 'Merma' });
    expect((await level(p.id)).onHand).toBe(7n);

    await sell(p.id, 5, 1_000n);
    expect(await level(p.id)).toEqual({ onHand: 7n, reserved: 5n, free: 2n });
    // Bajar a 4 dejaría la existencia por debajo de lo reservado (5).
    await expect(
      inventory.change(org, p.id, { kind: 'adjustment', quantity: -3, reason: 'Conteo' })
    ).rejects.toBeInstanceOf(InventoryConflictError);
    expect(await level(p.id)).toEqual({ onHand: 7n, reserved: 5n, free: 2n });

    const free = await catalog.createProduct(org, {
      name: 'Sin control',
      price: 100n,
      currency: 'VES',
    });
    expect(free.stock).toBeNull();
    await expect(
      inventory.change(org, free.id, { kind: 'receipt', quantity: 1, reason: 'Entrada' })
    ).rejects.toBeInstanceOf(StockNotTrackedError);

    const moves = await inventory.movements(org, p.id);
    expect(moves.map((m) => m.kind)).toEqual(['reservation', 'adjustment', 'receipt']);
  });
});

describe('reserva → descuento con cobro confirmado', () => {
  it('sin existencias libres no se crea nada (ni venta ni link)', async () => {
    const p = await tracked(500n, 2);
    const before = await ctx.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM commerce_orders WHERE tenant_id = $1`,
      [org]
    );
    const err = await sell(p.id, 3, 500n).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InsufficientStockError);
    expect((err as InsufficientStockError).available).toBe(2n);
    const after = await ctx.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM commerce_orders WHERE tenant_id = $1`,
      [org]
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
    expect(await level(p.id)).toEqual({ onHand: 2n, reserved: 0n, free: 2n });
  });

  it('aprobado ⇒ descuenta existencia y reserva; la venta muestra «descontada»', async () => {
    const p = await tracked(2_500n, 5);
    const o = await sell(p.id, 2, 2_500n);
    expect(o.stock).toEqual([{ productId: p.id, quantity: 2, status: 'reserved' }]);
    expect(await level(p.id)).toEqual({ onHand: 5n, reserved: 2n, free: 3n });
    await pay(o.paymentLinkId, 'tok_approve');
    expect(await level(p.id)).toEqual({ onHand: 3n, reserved: 0n, free: 3n });
    expect((await orders.get(org, o.id)).stock[0]!.status).toBe('sold');
  });

  it('rechazado ⇒ la reserva se mantiene; reintento aprobado ⇒ descuenta una sola vez', async () => {
    const p = await tracked(700n, 4);
    const o = await sell(p.id, 1, 700n);
    await pay(o.paymentLinkId, 'tok_decline');
    expect(await level(p.id)).toEqual({ onHand: 4n, reserved: 1n, free: 3n });
    await pay(o.paymentLinkId, 'tok_approve');
    expect(await level(p.id)).toEqual({ onHand: 3n, reserved: 0n, free: 3n });
    const sales = await ctx.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM inventory_movements WHERE order_id = $1 AND kind = 'sale'`,
      [o.id]
    );
    expect(sales.rows[0]!.n).toBe(1);
  });

  it('asíncrono o timeout (incierto) ⇒ sigue reservado y la venta NO se puede anular', async () => {
    const p = await tracked(900n, 3);
    const a = await sell(p.id, 1, 900n);
    await pay(a.paymentLinkId, 'tok_pse');
    const b = await sell(p.id, 1, 900n);
    await pay(b.paymentLinkId, 'tok_timeout');
    expect((await orders.get(org, b.id)).payment.state).toBe('payment_in_progress');
    expect(await level(p.id)).toEqual({ onHand: 3n, reserved: 2n, free: 1n });
    await expect(orders.cancel(org, a.id, { reason: 'Cliente se fue' })).rejects.toBeInstanceOf(
      OrderNotCancellableError
    );
    await expect(orders.cancel(org, b.id, { reason: 'Cliente se fue' })).rejects.toBeInstanceOf(
      OrderNotCancellableError
    );
    expect(await level(p.id)).toEqual({ onHand: 3n, reserved: 2n, free: 1n });
  });

  it('una devolución NO repone existencias por sí sola (decisión documentada)', async () => {
    const p = await tracked(1_200n, 2);
    const o = await sell(p.id, 1, 1_200n);
    await pay(o.paymentLinkId, 'tok_approve');
    const detail = await orders.get(org, o.id);
    const intentId = detail.payment.paymentIntentId!;
    await posting.releaseSettlement({
      tenantId: org,
      merchantId: merchant,
      idempotencyKey: `settle:${intentId}`,
      sourceType: 'settlement',
      sourceId: intentId,
      amount: Money.of(1_200n, 'VES'),
    });
    const r = await withTenantTransaction(ctx.app, org, (c) =>
      refunds.beginIn(c, org, { paymentIntentId: intentId })
    );
    await refunds.execute(org, r.id);
    expect((await orders.get(org, o.id)).payment.state).toBe('refunded');
    expect(await level(p.id)).toEqual({ onHand: 1n, reserved: 0n, free: 1n });
  });
});

describe('anular una venta sin cobro', () => {
  it('libera la reserva, desactiva el link y ningún checkout abierto puede cobrar', async () => {
    const p = await tracked(1_000n, 3);
    const o = await sell(p.id, 2, 1_000n);
    const open = await links.createSessionFromLink(o.paymentLinkId);
    const res = await orders.cancel(org, o.id, { reason: 'Cliente desistió', userId: null });
    expect(res.replayed).toBe(false);
    expect(res.order.payment.state).toBe('cancelled');
    expect(res.order.cancellation?.reason).toBe('Cliente desistió');
    expect(res.order.stock[0]!.status).toBe('released');
    expect(await level(p.id)).toEqual({ onHand: 3n, reserved: 0n, free: 3n });

    const err = await checkout
      .confirmByClientSecret(open.checkoutSessionId, open.clientSecret, 'tok_approve')
      .catch((e: unknown) => e);
    expect(isOrderCancelled(err)).toBe(true);
    await expect(links.createSessionFromLink(o.paymentLinkId)).rejects.toThrow();
    expect(await level(p.id)).toEqual({ onHand: 3n, reserved: 0n, free: 3n });

    // Reanular = replay; la lista filtra por estado.
    expect((await orders.cancel(org, o.id, { reason: 'otra vez' })).replayed).toBe(true);
    const cancelled = await orders.list(org, { state: 'cancelled' });
    expect(cancelled.data.map((x) => x.id)).toContain(o.id);
    const awaiting = await orders.list(org, { state: 'awaiting_payment' });
    expect(awaiting.data.map((x) => x.id)).not.toContain(o.id);
  });

  it('cobrada o con plan de cuotas vivo ⇒ no se anula; anulada ⇒ no admite plan', async () => {
    const p = await tracked(4_000n, 5);
    const paid = await sell(p.id, 1, 4_000n);
    await pay(paid.paymentLinkId, 'tok_approve');
    await expect(orders.cancel(org, paid.id, { reason: 'error' })).rejects.toBeInstanceOf(
      OrderNotCancellableError
    );

    const withPlan = await sell(p.id, 1, 4_000n);
    const s = await links.createSessionFromLink(withPlan.paymentLinkId);
    await installments.createPlanForSession(s.checkoutSessionId, s.clientSecret, {
      count: 4,
      scenario: 'approve',
      acceptTerms: true,
    });
    await expect(orders.cancel(org, withPlan.id, { reason: 'error' })).rejects.toBeInstanceOf(
      OrderNotCancellableError
    );

    const cancelled = await sell(p.id, 1, 4_000n);
    const s2 = await links.createSessionFromLink(cancelled.paymentLinkId);
    await orders.cancel(org, cancelled.id, { reason: 'Duplicada' });
    const err = await installments
      .createPlanForSession(s2.checkoutSessionId, s2.clientSecret, {
        count: 3,
        scenario: 'approve',
        acceptTerms: true,
      })
      .catch((e: unknown) => e);
    expect(err).toBeTruthy();
  });

  it('carrera anular ↔ cobrar: gana uno solo y las existencias cuadran', async () => {
    for (let i = 0; i < 6; i++) {
      const p = await tracked(300n, 1);
      const o = await sell(p.id, 1, 300n);
      const s = await links.createSessionFromLink(o.paymentLinkId);
      const [cancelR, payR] = await Promise.allSettled([
        orders.cancel(org, o.id, { reason: 'Carrera' }),
        checkout.confirmByClientSecret(s.checkoutSessionId, s.clientSecret, 'tok_approve'),
      ]);
      const after = await orders.get(org, o.id);
      const lv = await level(p.id);
      if (cancelR.status === 'fulfilled') {
        expect(payR.status).toBe('rejected');
        expect(after.payment.state).toBe('cancelled');
        expect(lv).toEqual({ onHand: 1n, reserved: 0n, free: 1n });
      } else {
        expect(payR.status).toBe('fulfilled');
        expect(after.payment.state).toBe('paid');
        expect(lv).toEqual({ onHand: 0n, reserved: 0n, free: 0n });
      }
    }
  });

  it('dos ventas compiten por la última unidad: una sola reserva', async () => {
    const p = await tracked(150n, 1);
    const results = await Promise.allSettled([sell(p.id, 1, 150n), sell(p.id, 1, 150n)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(InsufficientStockError);
    expect(await level(p.id)).toEqual({ onHand: 1n, reserved: 1n, free: 0n });
  });
});

describe('guardas del motor (aunque un camino se salte el servicio)', () => {
  it('descontar sin cobro, liberar sin anular o escribir niveles a mano: rechazado', async () => {
    const p = await tracked(1_000n, 5);
    const o = await sell(p.id, 1, 1_000n);
    const asApp = (sql: string, values: unknown[]) =>
      withTenantTransaction(ctx.app, org, (c) => c.query(sql, values));
    await expect(
      asApp(
        `INSERT INTO inventory_movements (tenant_id, product_id, kind, quantity, order_id)
         VALUES ($1, $2, 'sale', 1, $3)`,
        [org, p.id, o.id]
      )
    ).rejects.toThrow(/confirmed payment/);
    await expect(
      asApp(
        `INSERT INTO inventory_movements (tenant_id, product_id, kind, quantity, order_id)
         VALUES ($1, $2, 'release', 1, $3)`,
        [org, p.id, o.id]
      )
    ).rejects.toThrow(/cancelled sale/);
    await expect(
      asApp(`UPDATE inventory_levels SET on_hand = 99 WHERE product_id = $1`, [p.id])
    ).rejects.toThrow(/permission denied/);
    await expect(
      asApp(`UPDATE inventory_movements SET quantity = 9 WHERE order_id = $1`, [o.id])
    ).rejects.toThrow();
    expect(await level(p.id)).toEqual({ onHand: 5n, reserved: 1n, free: 4n });
  });

  it('aislamiento: otra organización no ve niveles ni movimientos', async () => {
    const p = await tracked(1_000n, 2);
    const seen = await withTenantTransaction(ctx.app, orgB, async (c) => {
      const a = await c.query(`SELECT 1 FROM inventory_levels WHERE product_id = $1`, [p.id]);
      const b = await c.query(`SELECT 1 FROM inventory_movements WHERE product_id = $1`, [p.id]);
      return (a.rowCount ?? 0) + (b.rowCount ?? 0);
    });
    expect(seen).toBe(0);
    await expect(
      inventory.change(orgB, p.id, { kind: 'receipt', quantity: 1, reason: 'ajena' })
    ).rejects.toThrow();
  });
});

describe('variantes e imágenes', () => {
  it('variante de un nivel, misma moneda; la línea copia la etiqueta', async () => {
    const base = await catalog.createProduct(org, {
      name: 'Café molido',
      sku: sku(),
      price: 3_500n,
      currency: 'VES',
      variantLabel: '250 g',
      imageRef: 'catalog/cafe-grano.jpg',
    });
    const big = await catalog.createProduct(org, {
      name: 'Café molido',
      sku: sku(),
      price: 6_500n,
      currency: 'VES',
      variantOf: base.id,
      variantLabel: '500 g',
    });
    expect(big.variantOf).toBe(base.id);
    await expect(
      catalog.createProduct(org, {
        name: 'Café',
        price: 1n,
        currency: 'VES',
        variantOf: big.id,
        variantLabel: '1 kg',
      })
    ).rejects.toBeInstanceOf(CatalogVariantError);
    await expect(
      catalog.createProduct(org, {
        name: 'Café',
        price: 1n,
        currency: 'USD',
        variantOf: base.id,
        variantLabel: '1 kg',
      })
    ).rejects.toBeInstanceOf(CatalogVariantError);
    await expect(
      catalog.createProduct(org, { name: 'Café', price: 1n, currency: 'VES', variantOf: base.id })
    ).rejects.toBeInstanceOf(CatalogVariantError);
    await expect(
      withTenantTransaction(ctx.app, org, (c) =>
        c.query(`UPDATE catalog_products SET variant_of = NULL WHERE id = $1`, [big.id])
      )
    ).rejects.toThrow(/fixed at creation/);

    const o = await withTenantTransaction(ctx.app, org, (c) =>
      orders.createIn(c, org, {
        merchantId: merchant,
        currency: 'VES',
        lines: [{ productId: big.id, quantity: 1 }],
        expectedTotal: 6_500n,
      })
    );
    expect(o.lines[0]).toMatchObject({ name: 'Café molido', variantLabel: '500 g' });
    const list = await catalog.listProducts(org, { q: '500 g' });
    expect(list.map((x) => x.id)).toContain(big.id);
  });

  it('solo imágenes del conjunto de demostración', async () => {
    await expect(
      catalog.createProduct(org, {
        name: 'X',
        price: 1n,
        currency: 'VES',
        imageRef: 'catalog/otra.jpg',
      })
    ).rejects.toBeInstanceOf(UnknownImageError);
    await expect(
      withTenantTransaction(ctx.app, org, (c) =>
        c.query(
          `INSERT INTO catalog_products (tenant_id, name, price, currency, image_ref)
           VALUES ($1, 'X', 1, 'VES', 'https://evil.example/x.jpg')`,
          [org]
        )
      )
    ).rejects.toThrow();
    const ok = await catalog.createProduct(org, {
      name: 'Agua',
      price: 1n,
      currency: 'VES',
      imageRef: 'catalog/agua.jpg',
    });
    expect(ok.imageRef).toBe('catalog/agua.jpg');
  });
});

describe('indicadores: evolución, más vendidos y saldo', () => {
  it('serie diaria de la moneda, top de ventas cobradas, anuladas aparte y saldo por moneda', async () => {
    const { SummaryService } = await import('../src/index.js');
    const summary = new SummaryService(ctx.app);
    const t = await ctx.createTenant(`Ins ${randomUUID().slice(0, 8)}`);
    const m = await ctx.admin.query<{ id: string }>(
      `INSERT INTO merchants (tenant_id, name) VALUES ($1, 'I') RETURNING id`,
      [t]
    );
    const a = await catalog.createProduct(t, { name: 'Arepa', price: 250n, currency: 'VES' });
    const b = await catalog.createProduct(t, { name: 'Malta', price: 150n, currency: 'VES' });
    const u = await catalog.createProduct(t, { name: 'Café', price: 300n, currency: 'USD' });
    const mk = (
      currency: string,
      lines: Array<{ productId: string; quantity: number }>,
      total: bigint
    ) =>
      withTenantTransaction(ctx.app, t, (c) =>
        orders.createIn(c, t, { merchantId: m.rows[0]!.id, currency, lines, expectedTotal: total })
      );
    const paid1 = await mk('VES', [{ productId: a.id, quantity: 3 }], 750n);
    const paid2 = await mk(
      'VES',
      [
        { productId: a.id, quantity: 1 },
        { productId: b.id, quantity: 2 },
      ],
      550n
    );
    await mk('VES', [{ productId: b.id, quantity: 9 }], 1_350n); // sin cobrar: no cuenta en el top
    const cancelled = await mk('VES', [{ productId: b.id, quantity: 1 }], 150n);
    const usd = await mk('USD', [{ productId: u.id, quantity: 1 }], 300n);
    for (const o of [paid1, paid2, usd]) {
      const s = await links.createSessionFromLink(o.paymentLinkId);
      await checkout.confirmByClientSecret(s.checkoutSessionId, s.clientSecret, 'tok_approve');
    }
    await orders.cancel(t, cancelled.id, { reason: 'Prueba' });

    const from = new Date(Date.now() - 2 * 86_400_000);
    const to = new Date(Date.now() + 86_400_000);
    const ins = await summary.insights(t, from, to);
    expect(ins.currency).toBe('VES'); // la de más actividad
    expect(ins.currencies).toEqual(['VES', 'USD']);
    expect(ins.series.length).toBeGreaterThanOrEqual(3);
    const today = ins.series.find((p) => p.ordersCount > 0)!;
    expect(today).toMatchObject({
      ordersCount: 4,
      ordersAmount: 2_800n,
      confirmedCount: 2,
      confirmedAmount: 1_300n,
    });
    expect(ins.activeDays).toBe(1);
    expect(ins.topProducts.map((p) => [p.name, p.quantity, p.amount])).toEqual([
      ['Arepa', 4, 1_000n],
      ['Malta', 2, 300n],
    ]);
    const usdIns = await summary.insights(t, from, to, 'USD');
    expect(usdIns.topProducts.map((p) => p.name)).toEqual(['Café']);
    // Saldo: lo cobrado queda PENDIENTE de liquidación por moneda (no disponible).
    expect(ins.balances).toEqual([
      { currency: 'USD', pending: 300n, available: 0n, reserve: 0n },
      { currency: 'VES', pending: 1_300n, available: 0n, reserve: 0n },
    ]);

    const sum = await summary.summary(t, from, to);
    expect(sum.ordersCancelled).toEqual([{ currency: 'VES', count: 1, amount: 150n }]);
    expect(sum.ordersAwaitingPayment).toEqual([{ currency: 'VES', count: 1, amount: 1_350n }]);
  });
});

describe('indicadores: serie de varios días', () => {
  it('agrupa por día UTC y cuenta días activos (filas retrofechadas en la prueba)', async () => {
    const { SummaryService } = await import('../src/index.js');
    const summary = new SummaryService(ctx.app);
    const t = await ctx.createTenant(`Days ${randomUUID().slice(0, 8)}`);
    const m = await ctx.admin.query<{ id: string }>(
      `INSERT INTO merchants (tenant_id, name) VALUES ($1, 'D') RETURNING id`,
      [t]
    );
    const p = await catalog.createProduct(t, { name: 'Arepa', price: 250n, currency: 'VES' });
    const sale = async () => {
      const o = await withTenantTransaction(ctx.app, t, (c) =>
        orders.createIn(c, t, {
          merchantId: m.rows[0]!.id,
          currency: 'VES',
          lines: [{ productId: p.id, quantity: 1 }],
          expectedTotal: 250n,
        })
      );
      const s = await links.createSessionFromLink(o.paymentLinkId);
      await checkout.confirmByClientSecret(s.checkoutSessionId, s.clientSecret, 'tok_approve');
      return o;
    };
    const old = await sale();
    await sale();
    // Mover la primera venta (pedido + su cobro) dos días atrás. Superusuario y
    // triggers en réplica: SOLO aquí, para fabricar historia en la prueba.
    const c = await ctx.admin.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SET LOCAL session_replication_role = replica`);
      await c.query(
        `UPDATE commerce_orders SET created_at = created_at - interval '2 days' WHERE id = $1`,
        [old.id]
      );
      await c.query(
        `UPDATE payment_intents SET created_at = created_at - interval '2 days'
         WHERE payment_link_id = $1`,
        [old.paymentLinkId]
      );
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    const now = Date.now();
    const ins = await summary.insights(
      t,
      new Date(now - 6 * 86_400_000),
      new Date(now + 86_400_000)
    );
    expect(ins.series.length).toBeGreaterThanOrEqual(7);
    expect(ins.activeDays).toBe(2);
    const active = ins.series.filter((d) => d.ordersCount > 0);
    expect(active.map((d) => [d.ordersCount, d.confirmedAmount])).toEqual([
      [1, 250n],
      [1, 250n],
    ]);
    const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    expect(active.map((d) => d.day)).toEqual([dayOf(now - 2 * 86_400_000), dayOf(now)]);
  });
});
