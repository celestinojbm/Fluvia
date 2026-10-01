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
  InstallmentSandboxService,
  OrderCurrencyMismatchError,
  OrderService,
  SummaryService,
} from '../src/index.js';

/**
 * Bolívares (VES, ISO 4217 928, exponente 2) de punta a punta contra
 * PostgreSQL REAL + MockProvider: catálogo → venta → cobro → devolución
 * parcial → cuotas simuladas → indicadores. Unidades menores enteras (céntimos)
 * en todo el servidor; sin conversiones ni tasas.
 */

let ctx: TestContext;
let catalog: CatalogService;
let orders: OrderService;
let summary: SummaryService;
let installments: InstallmentSandboxService;
let links: PaymentLinkService;
let checkout: CheckoutSessionService;
let refunds: RefundService;
let posting: PostingService;
let ledger: LedgerService;
let intents: PaymentIntentService;
let org: string;
let merchant: string;

beforeAll(async () => {
  ctx = await createTestContext();
  intents = new PaymentIntentService(ctx.app);
  ledger = new LedgerService(ctx.app);
  posting = new PostingService(ledger, ctx.app);
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
  summary = new SummaryService(ctx.app);
  installments = new InstallmentSandboxService(ctx.app, orders);
  refunds = new RefundService(ctx.app, intents, posting, new MockPaymentProvider());
  org = await ctx.createTenant(`Bodega ${randomUUID().slice(0, 8)}`);
  const m = await ctx.admin.query<{ id: string }>(
    `INSERT INTO merchants (tenant_id, name, default_currency) VALUES ($1, 'Bodega Caracas', 'VES') RETURNING id`,
    [org]
  );
  merchant = m.rows[0]!.id;
}, 30_000);

afterAll(async () => {
  await ctx.close();
});

const sku = () => `VE-${randomUUID().slice(0, 8)}`;
const ves = (text: string) => Money.fromDecimal(text, 'VES').amount;

async function vesProduct(price: string, name = `Producto ${randomUUID().slice(0, 6)}`) {
  return catalog.createProduct(org, { name, sku: sku(), price: ves(price), currency: 'VES' });
}

async function sale(lines: Array<{ productId: string; quantity: number }>, expectedTotal: bigint) {
  return withTenantTransaction(ctx.app, org, (c) =>
    orders.createIn(c, org, { merchantId: merchant, currency: 'VES', lines, expectedTotal })
  );
}

describe('VES — catálogo y venta', () => {
  it('precio con decimales en céntimos; total en servidor exacto (sin coma flotante)', async () => {
    // 0,10 + 0,20 en double = 0,30000000000000004; en céntimos enteros = 30.
    const a = await vesProduct('0.10');
    const b = await vesProduct('0.20');
    const c = await vesProduct('1234.56');
    expect(a.price).toBe(10n);
    expect(c.currency).toBe('VES');
    const order = await sale(
      [
        { productId: a.id, quantity: 1 },
        { productId: b.id, quantity: 1 },
        { productId: c.id, quantity: 3 },
      ],
      30n + 370_368n
    );
    expect(order.total).toBe(370_398n); // Bs. 3.703,98
    expect(order.currency).toBe('VES');
    const detail = await orders.get(org, order.id);
    expect(detail.lines.map((l) => [l.unitPrice, l.quantity, l.lineTotal])).toEqual([
      [10n, 1, 10n],
      [20n, 1, 20n],
      [123_456n, 3, 370_368n],
    ]);
    // El link de cobro único hereda moneda e importe exactos.
    const link = await ctx.admin.query<{ amount: string; currency: string }>(
      `SELECT amount::text, currency FROM payment_links WHERE id = $1`,
      [order.paymentLinkId]
    );
    expect(link.rows[0]).toEqual({ amount: '370398', currency: 'VES' });
  });

  it('no se mezclan VES y USD (ni VES y COP) en una venta', async () => {
    const bs = await vesProduct('10.00');
    const usd = await catalog.createProduct(org, {
      name: `USD ${randomUUID().slice(0, 6)}`,
      sku: sku(),
      price: 500n,
      currency: 'USD',
    });
    const cop = await catalog.createProduct(org, {
      name: `COP ${randomUUID().slice(0, 6)}`,
      sku: sku(),
      price: 4_800n,
      currency: 'COP',
    });
    await expect(
      sale(
        [
          { productId: bs.id, quantity: 1 },
          { productId: usd.id, quantity: 1 },
        ],
        1_500n
      )
    ).rejects.toBeInstanceOf(OrderCurrencyMismatchError);
    await expect(
      sale(
        [
          { productId: bs.id, quantity: 1 },
          { productId: cop.id, quantity: 1 },
        ],
        5_800n
      )
    ).rejects.toBeInstanceOf(OrderCurrencyMismatchError);
  });
});

describe('VES — cobro, devolución parcial y justificante', () => {
  it('cobro aprobado contabiliza en VES; devolución parcial exacta; resto devolvible exacto', async () => {
    const p = await vesProduct('250.75');
    const order = await sale([{ productId: p.id, quantity: 1 }], 25_075n);
    const s = await links.createSessionFromLink(order.paymentLinkId);
    await checkout.confirmByClientSecret(s.checkoutSessionId, s.clientSecret, 'tok_approve');
    const detail = await orders.get(org, order.id);
    expect(detail.payment.state).toBe('paid');
    const intentId = detail.payment.paymentIntentId!;
    const intent = await intents.get(org, intentId);
    expect(intent.currency).toBe('VES');
    expect(intent.amountCaptured).toBe('25075');

    // El ledger del comercio se abre en VES (cuentas por moneda, sin mezclar).
    const chart = await posting.ensureChart(org, merchant, 'VES');
    const pending = await ledger.getBalance(org, chart['merchant.pending']);
    expect(BigInt(pending.available)).toBeGreaterThanOrEqual(25_075n);
    // Liberación sandbox para que exista saldo devolvible (mismo flujo que COP).
    await posting.releaseSettlement({
      tenantId: org,
      merchantId: merchant,
      idempotencyKey: `settle:${intentId}`,
      sourceType: 'settlement',
      sourceId: intentId,
      amount: Money.of(25_075n, 'VES'),
    });

    // Devolución parcial de Bs. 100,25.
    const r = await withTenantTransaction(ctx.app, org, (c) =>
      refunds.beginIn(c, org, { paymentIntentId: intentId, amount: 10_025n, reason: 'parcial' })
    );
    expect(r.currency).toBe('VES');
    await refunds.execute(org, r.id);
    const after = await intents.get(org, intentId);
    expect(after.status).toBe('partially_refunded');
    expect(after.amountRefunded).toBe('10025');
    const remaining = BigInt(after.amountCaptured) - BigInt(after.amountRefunded);
    expect(Money.of(remaining, 'VES').toDecimalString()).toBe('150.50');

    // Pedir más de lo que queda se rechaza; lo justo se acepta.
    await expect(
      withTenantTransaction(ctx.app, org, (c) =>
        refunds.beginIn(c, org, { paymentIntentId: intentId, amount: remaining + 1n })
      )
    ).rejects.toThrow();
    const r2 = await withTenantTransaction(ctx.app, org, (c) =>
      refunds.beginIn(c, org, { paymentIntentId: intentId, amount: remaining })
    );
    await refunds.execute(org, r2.id);
    const final = await intents.get(org, intentId);
    expect(final.status).toBe('refunded');
    expect(final.amountRefunded).toBe('25075');
    expect((await orders.get(org, order.id)).payment.state).toBe('refunded');
  });
});

describe('VES — cuotas simuladas con suma exacta', () => {
  it('Bs. 100,00 en 3 cuotas = 33,34 + 33,33 + 33,33; Σ = total en el motor', async () => {
    const p = await vesProduct('100.00');
    const order = await sale([{ productId: p.id, quantity: 1 }], 10_000n);
    const s = await links.createSessionFromLink(order.paymentLinkId);
    const { plan } = await installments.createPlanForSession(s.checkoutSessionId, s.clientSecret, {
      count: 3,
      scenario: 'approve',
      acceptTerms: true,
    });
    expect(plan.currency).toBe('VES');
    expect(plan.installments.map((i) => i.amount)).toEqual([3_334n, 3_333n, 3_333n]);
    expect(plan.installments.reduce((a, i) => a + i.amount, 0n)).toBe(plan.total);
  });

  it('propiedad: cualquier total en céntimos y 3/4/6 cuotas suma exacto y difiere ≤ 1 céntimo', () => {
    for (const total of [1n, 7n, 99n, 10_001n, 123_457n, 9_007_199_254_740_991n]) {
      for (const n of [3, 4, 6]) {
        if (total < BigInt(n)) continue;
        const q = installments.quote(total, 'VES', n);
        const amounts = q.schedule.map((x) => x.amount);
        expect(amounts.reduce((a, b) => a + b, 0n)).toBe(total);
        const max = amounts.reduce((a, b) => (b > a ? b : a));
        const min = amounts.reduce((a, b) => (b < a ? b : a));
        expect(max - min <= 1n).toBe(true);
      }
    }
  });
});

describe('VES — indicadores agrupados por moneda (nunca sumados)', () => {
  it('VES, USD y COP aparecen por separado', async () => {
    const t = await ctx.createTenant(`Mix ${randomUUID().slice(0, 8)}`);
    const m = await ctx.admin.query<{ id: string }>(
      `INSERT INTO merchants (tenant_id, name) VALUES ($1, 'Mix') RETURNING id`,
      [t]
    );
    const mk = async (currency: string, price: bigint) => {
      const p = await catalog.createProduct(t, { name: `P ${currency}`, price, currency });
      const o = await withTenantTransaction(ctx.app, t, (c) =>
        orders.createIn(c, t, {
          merchantId: m.rows[0]!.id,
          currency,
          lines: [{ productId: p.id, quantity: 1 }],
          expectedTotal: price,
        })
      );
      const s = await links.createSessionFromLink(o.paymentLinkId);
      await checkout.confirmByClientSecret(s.checkoutSessionId, s.clientSecret, 'tok_approve');
    };
    await mk('VES', 123_456n);
    await mk('USD', 1_250n);
    await mk('COP', 48_000n);
    const sum = await summary.summary(
      t,
      new Date(Date.now() - 3_600_000),
      new Date(Date.now() + 3_600_000)
    );
    expect(sum.confirmed).toEqual([
      { currency: 'COP', count: 1, amount: 48_000n },
      { currency: 'USD', count: 1, amount: 1_250n },
      { currency: 'VES', count: 1, amount: 123_456n },
    ]);
  });
});
