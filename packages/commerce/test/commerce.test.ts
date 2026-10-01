import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenantTransaction } from '@fluvia/db';
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
  CatalogDuplicateError,
  CatalogService,
  CustomerNotVisibleError,
  InstallmentInvalidStateError,
  InstallmentPlanNotAllowedError,
  InstallmentSandboxService,
  InstallmentTermsNotAcceptedError,
  OrderCurrencyMismatchError,
  OrderNotFoundError,
  OrderService,
  OrderTotalMismatchError,
  ProductNotFoundError,
  ProductUnavailableError,
  ProductVersionConflictError,
  SummaryService,
  isInstallmentPlanActive,
  type CreateOrderInput,
} from '../src/index.js';

/**
 * Plataforma del comercio contra PostgreSQL REAL + MockProvider:
 * catálogo, pedidos con cálculo en servidor, precio histórico, invariantes
 * del motor, aislamiento entre organizaciones, derivación del estado de pago
 * y el motor de cuotas SANDBOX separado de la contabilidad.
 */

let ctx: TestContext;
let catalog: CatalogService;
let orders: OrderService;
let summary: SummaryService;
let installments: InstallmentSandboxService;
let links: PaymentLinkService;
let checkout: CheckoutSessionService;
let org: string;
let orgB: string;
let merchant: string;
let merchantB: string;

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
  orders = new OrderService(ctx.app, links);
  summary = new SummaryService(ctx.app);
  installments = new InstallmentSandboxService(ctx.app, orders);
  org = await ctx.createTenant(`Shop ${randomUUID().slice(0, 8)}`);
  orgB = await ctx.createTenant(`Shop-B ${randomUUID().slice(0, 8)}`);
  const m = await ctx.admin.query<{ id: string }>(
    `INSERT INTO merchants (tenant_id, name) VALUES ($1, 'Tienda A') RETURNING id`,
    [org]
  );
  merchant = m.rows[0]!.id;
  const mb = await ctx.admin.query<{ id: string }>(
    `INSERT INTO merchants (tenant_id, name) VALUES ($1, 'Tienda B') RETURNING id`,
    [orgB]
  );
  merchantB = mb.rows[0]!.id;
}, 30_000);

afterAll(async () => {
  await ctx.close();
});

const sku = () => `SKU-${randomUUID().slice(0, 8)}`;

async function product(price: bigint, opts: { currency?: string; available?: boolean } = {}) {
  return catalog.createProduct(org, {
    name: `Producto ${randomUUID().slice(0, 6)}`,
    sku: sku(),
    price,
    currency: opts.currency ?? 'USD',
    available: opts.available,
  });
}

async function createOrder(
  tenant: string,
  input: Omit<CreateOrderInput, 'currency'> & { currency?: string }
) {
  return withTenantTransaction(ctx.app, tenant, (c) =>
    orders.createIn(c, tenant, { currency: 'USD', ...input })
  );
}

describe('catálogo', () => {
  it('crea, busca por nombre/sku y edita con concurrencia optimista', async () => {
    const cat = await catalog.createCategory(org, `Bebidas ${randomUUID().slice(0, 4)}`);
    const p = await catalog.createProduct(org, {
      name: 'Café molido 500 g',
      sku: sku(),
      price: 1_250n,
      currency: 'USD',
      categoryId: cat.id,
    });
    expect(p.version).toBe(1);
    expect(p.categoryName).toBe(cat.name);

    const found = await catalog.listProducts(org, { q: 'café molido' });
    expect(found.map((x) => x.id)).toContain(p.id);
    const bySku = await catalog.listProducts(org, { q: p.sku! });
    expect(bySku.map((x) => x.id)).toEqual([p.id]);
    // Comodines LIKE escapados: «%» no lo encuentra todo.
    expect((await catalog.listProducts(org, { q: '%' })).length).toBe(0);

    const edited = await catalog.updateProduct(org, p.id, { price: 1_400n, expectedVersion: 1 });
    expect(edited.price).toBe(1_400n);
    expect(edited.version).toBe(2);
    await expect(
      catalog.updateProduct(org, p.id, { price: 1_500n, expectedVersion: 1 })
    ).rejects.toBeInstanceOf(ProductVersionConflictError);
  });

  it('SKU y nombre de categoría duplicados se rechazan con error de dominio', async () => {
    const p = await product(100n);
    await expect(
      catalog.createProduct(org, { name: 'Otro', sku: p.sku, price: 100n, currency: 'USD' })
    ).rejects.toBeInstanceOf(CatalogDuplicateError);
    const name = `Cat ${randomUUID().slice(0, 4)}`;
    await catalog.createCategory(org, name);
    await expect(catalog.createCategory(org, ` ${name.toUpperCase()} `)).rejects.toBeInstanceOf(
      CatalogDuplicateError
    );
  });

  it('aislamiento: otra organización no ve ni edita el producto', async () => {
    const p = await product(500n);
    await expect(catalog.getProduct(orgB, p.id)).rejects.toBeInstanceOf(ProductNotFoundError);
    await expect(
      catalog.updateProduct(orgB, p.id, { price: 1n, expectedVersion: 1 })
    ).rejects.toBeInstanceOf(ProductNotFoundError);
    expect((await catalog.listProducts(orgB)).map((x) => x.id)).not.toContain(p.id);
  });
});

describe('pedidos: total en servidor y precio histórico', () => {
  it('calcula el total en servidor y crea la venta de cobro único por ese importe', async () => {
    const a = await product(1_250n);
    const b = await product(399n);
    const order = await createOrder(org, {
      merchantId: merchant,
      lines: [
        { productId: a.id, quantity: 2 },
        { productId: b.id, quantity: 3 },
      ],
      expectedTotal: 3_697n,
    });
    expect(order.total).toBe(3_697n);
    expect(order.lines.map((l) => l.lineTotal)).toEqual([2_500n, 1_197n]);
    expect(order.payment.state).toBe('awaiting_payment');
    const link = await links.get(org, order.paymentLinkId);
    expect(link.singleCharge).toBe(true);
    expect(link.amount).toBe('3697');
    expect(link.currency).toBe('USD');
  });

  it('si el precio cambió mientras se armaba el carrito, NO crea nada (ni pedido ni link)', async () => {
    const a = await product(1_000n);
    const before = await ctx.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM payment_links WHERE tenant_id = $1`,
      [org]
    );
    await catalog.updateProduct(org, a.id, { price: 1_100n, expectedVersion: 1 });
    await expect(
      createOrder(org, {
        merchantId: merchant,
        lines: [{ productId: a.id, quantity: 1 }],
        expectedTotal: 1_000n,
      })
    ).rejects.toBeInstanceOf(OrderTotalMismatchError);
    const after = await ctx.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM payment_links WHERE tenant_id = $1`,
      [org]
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it('conserva nombre y precio históricos aunque el producto cambie después', async () => {
    const a = await product(2_000n);
    const order = await createOrder(org, {
      merchantId: merchant,
      lines: [{ productId: a.id, quantity: 1 }],
      expectedTotal: 2_000n,
    });
    await catalog.updateProduct(org, a.id, {
      name: 'Nombre nuevo',
      price: 9_999n,
      archived: true,
      expectedVersion: 1,
    });
    const again = await orders.get(org, order.id);
    expect(again.lines[0]!.unitPrice).toBe(2_000n);
    expect(again.lines[0]!.name).toBe(a.name);
    expect(again.total).toBe(2_000n);
  });

  it('rechaza producto no disponible, archivado, de otra moneda o de otra organización', async () => {
    const off = await product(100n, { available: false });
    await expect(
      createOrder(org, {
        merchantId: merchant,
        lines: [{ productId: off.id, quantity: 1 }],
        expectedTotal: 100n,
      })
    ).rejects.toBeInstanceOf(ProductUnavailableError);

    const cop = await product(100n, { currency: 'COP' });
    await expect(
      createOrder(org, {
        merchantId: merchant,
        lines: [{ productId: cop.id, quantity: 1 }],
        expectedTotal: 100n,
      })
    ).rejects.toBeInstanceOf(OrderCurrencyMismatchError);

    const mine = await product(100n);
    await expect(
      createOrder(orgB, {
        merchantId: merchantB,
        lines: [{ productId: mine.id, quantity: 1 }],
        expectedTotal: 100n,
      })
    ).rejects.toBeInstanceOf(ProductUnavailableError);
  });

  it('cliente opcional: uno de otra organización es invisible', async () => {
    const cu = await ctx.admin.query<{ id: string }>(
      `INSERT INTO customers (tenant_id, name) VALUES ($1, 'Cliente B') RETURNING id`,
      [orgB]
    );
    const a = await product(100n);
    await expect(
      createOrder(org, {
        merchantId: merchant,
        customerId: cu.rows[0]!.id,
        lines: [{ productId: a.id, quantity: 1 }],
        expectedTotal: 100n,
      })
    ).rejects.toBeInstanceOf(CustomerNotVisibleError);
  });

  it('el pedido es inmutable y otra organización no lo ve', async () => {
    const a = await product(700n);
    const order = await createOrder(org, {
      merchantId: merchant,
      lines: [{ productId: a.id, quantity: 1 }],
      expectedTotal: 700n,
    });
    await expect(
      withTenantTransaction(ctx.app, org, (c) =>
        c.query(`UPDATE commerce_orders SET total = 1 WHERE id = $1`, [order.id])
      )
    ).rejects.toThrow();
    await expect(
      withTenantTransaction(ctx.app, org, (c) =>
        c.query(`UPDATE commerce_order_lines SET unit_price = 1 WHERE order_id = $1`, [order.id])
      )
    ).rejects.toThrow();
    await expect(orders.get(orgB, order.id)).rejects.toBeInstanceOf(OrderNotFoundError);
    const listB = await orders.list(orgB);
    expect(listB.data.map((o) => o.id)).not.toContain(order.id);
  });

  it('motor: una línea añadida después (otra tx) rompe Σ = total y se rechaza al COMMIT', async () => {
    const a = await product(300n);
    const order = await createOrder(org, {
      merchantId: merchant,
      lines: [{ productId: a.id, quantity: 1 }],
      expectedTotal: 300n,
    });
    await expect(
      withTenantTransaction(ctx.app, org, (c) =>
        c.query(
          `INSERT INTO commerce_order_lines
             (tenant_id, order_id, position, name, unit_price, quantity, line_total, currency)
           VALUES ($1, $2, 2, 'extra', 100, 1, 100, 'USD')`,
          [org, order.id]
        )
      )
    ).rejects.toThrow(/FLUVIA_ORDER_INVARIANT/);
  });

  it('motor: un pedido cuyo link no coincide con su total se rechaza al COMMIT', async () => {
    const link = await withTenantTransaction(ctx.app, org, (c) =>
      links.createIn(c, org, {
        merchantId: merchant,
        amount: 999n,
        currency: 'USD',
        singleCharge: true,
      })
    );
    await expect(
      withTenantTransaction(ctx.app, org, async (c) => {
        const o = await c.query<{ id: string }>(
          `INSERT INTO commerce_orders (tenant_id, number, merchant_id, currency, total, line_count,
             payment_link_id) VALUES ($1, 999999, $2, 'USD', 500, 1, $3) RETURNING id`,
          [org, merchant, link.id]
        );
        await c.query(
          `INSERT INTO commerce_order_lines
             (tenant_id, order_id, position, name, unit_price, quantity, line_total, currency)
           VALUES ($1, $2, 1, 'x', 500, 1, 500, 'USD')`,
          [org, o.rows[0]!.id]
        );
      })
    ).rejects.toThrow(/FLUVIA_ORDER_INVARIANT/);
  });

  it('numeración por organización sin huecos bajo concurrencia', async () => {
    const a = await product(100n);
    const created = await Promise.all(
      Array.from({ length: 6 }, () =>
        createOrder(org, {
          merchantId: merchant,
          lines: [{ productId: a.id, quantity: 1 }],
          expectedTotal: 100n,
        })
      )
    );
    const nums = created.map((o) => o.number).sort((x, y) => x - y);
    expect(new Set(nums).size).toBe(6);
    expect(nums[5]! - nums[0]!).toBe(5);
  });
});

describe('estado de pago derivado de los cobros reales (flujo existente)', () => {
  async function orderOf(price: bigint) {
    const a = await product(price);
    return createOrder(org, {
      merchantId: merchant,
      lines: [{ productId: a.id, quantity: 1 }],
      expectedTotal: price,
    });
  }

  it('aprobado ⇒ paid; un segundo checkout de la venta no puede cobrar', async () => {
    const order = await orderOf(4_200n);
    const s1 = await links.createSessionFromLink(order.paymentLinkId);
    const s2 = await links.createSessionFromLink(order.paymentLinkId);
    await checkout.confirmByClientSecret(s1.checkoutSessionId, s1.clientSecret, 'tok_approve');
    await expect(
      checkout.confirmByClientSecret(s2.checkoutSessionId, s2.clientSecret, 'tok_approve')
    ).rejects.toThrow();
    const o = await orders.get(org, order.id);
    expect(o.payment.state).toBe('paid');
    expect(o.payment.checkoutCount).toBe(2);
    const paid = await orders.list(org, { state: 'paid' });
    expect(paid.data.map((x) => x.id)).toContain(order.id);
  });

  it('rechazado ⇒ sigue esperando pago (último intento failed); asíncrono ⇒ en curso (incierto)', async () => {
    const declined = await orderOf(1_000n);
    const s = await links.createSessionFromLink(declined.paymentLinkId);
    await checkout.confirmByClientSecret(s.checkoutSessionId, s.clientSecret, 'tok_decline');
    const d = await orders.get(org, declined.id);
    expect(d.payment.state).toBe('awaiting_payment');
    expect(d.payment.latestIntentStatus).toBe('failed');

    const pending = await orderOf(1_000n);
    const p = await links.createSessionFromLink(pending.paymentLinkId);
    await checkout.confirmByClientSecret(p.checkoutSessionId, p.clientSecret, 'tok_pse');
    const pp = await orders.get(org, pending.id);
    expect(pp.payment.state).toBe('payment_in_progress');
    const inFlight = await orders.list(org, { state: 'payment_in_progress' });
    expect(inFlight.data.map((x) => x.id)).toContain(pending.id);
  });
});

describe('cuotas SANDBOX (proveedor simulado, separado de la contabilidad)', () => {
  async function orderWithSession(price: bigint) {
    const a = await product(price);
    const order = await createOrder(org, {
      merchantId: merchant,
      lines: [{ productId: a.id, quantity: 1 }],
      expectedTotal: price,
    });
    const s = await links.createSessionFromLink(order.paymentLinkId);
    return { order, s };
  }

  async function ledgerRows(): Promise<number> {
    const r = await ctx.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ledger_entries WHERE tenant_id = $1`,
      [org]
    );
    return r.rows[0]!.n;
  }

  it('exige aceptación explícita de las condiciones', async () => {
    const { s } = await orderWithSession(10_000n);
    await expect(
      installments.createPlanForSession(s.checkoutSessionId, s.clientSecret, {
        count: 4,
        scenario: 'approve',
        acceptTerms: false,
      })
    ).rejects.toBeInstanceOf(InstallmentTermsNotAcceptedError);
  });

  it('aprobado: Σ cuotas = total, NO marca pagado, NO toca ledger y bloquea el cobro con tarjeta', async () => {
    const { order, s } = await orderWithSession(10_001n);
    const ledgerBefore = await ledgerRows();
    const { plan, replayed } = await installments.createPlanForSession(
      s.checkoutSessionId,
      s.clientSecret,
      { count: 3, scenario: 'approve', acceptTerms: true }
    );
    expect(replayed).toBe(false);
    expect(plan.status).toBe('approved');
    expect(plan.installments.map((i) => i.amount)).toEqual([3_334n, 3_334n, 3_333n]);
    expect(plan.installments.reduce((a, i) => a + i.amount, 0n)).toBe(10_001n);
    expect(plan.events.map((e) => `${e.actor}:${e.kind}`)).toEqual([
      'buyer:plan_requested',
      'simulated_provider:plan_approved',
    ]);

    const o = await orders.get(org, order.id);
    expect(o.payment.state).toBe('awaiting_payment');
    expect(o.installments?.status).toBe('approved');
    expect(await ledgerRows()).toBe(ledgerBefore);

    // Reenvío idéntico ⇒ el mismo plan (idempotente).
    const again = await installments.createPlanForSession(s.checkoutSessionId, s.clientSecret, {
      count: 3,
      scenario: 'approve',
      acceptTerms: true,
    });
    expect(again.replayed).toBe(true);
    expect(again.plan.id).toBe(plan.id);
    // Otro número de cuotas con un plan vivo ⇒ conflicto.
    await expect(
      installments.createPlanForSession(s.checkoutSessionId, s.clientSecret, {
        count: 6,
        scenario: 'approve',
        acceptTerms: true,
      })
    ).rejects.toBeInstanceOf(InstallmentPlanNotAllowedError);

    // Garantía de doble cobro: el MOTOR impide empezar el cobro con tarjeta.
    const err = await checkout
      .confirmByClientSecret(s.checkoutSessionId, s.clientSecret, 'tok_approve')
      .catch((e: unknown) => e);
    expect(isInstallmentPlanActive(err)).toBe(true);
    const after = await orders.get(org, order.id);
    expect(after.payment.state).toBe('awaiting_payment');
    expect(await ledgerRows()).toBe(ledgerBefore);
  });

  it('venta ya cobrada ⇒ no admite plan', async () => {
    const { s } = await orderWithSession(5_000n);
    await checkout.confirmByClientSecret(s.checkoutSessionId, s.clientSecret, 'tok_approve');
    await expect(
      installments.createPlanForSession(s.checkoutSessionId, s.clientSecret, {
        count: 3,
        scenario: 'approve',
        acceptTerms: true,
      })
    ).rejects.toBeInstanceOf(InstallmentPlanNotAllowedError);
  });

  it('carrera tarjeta vs. cuotas: como mucho uno de los dos gana', async () => {
    for (let i = 0; i < 4; i++) {
      const { order, s } = await orderWithSession(6_000n);
      const [card, plan] = await Promise.allSettled([
        checkout.confirmByClientSecret(s.checkoutSessionId, s.clientSecret, 'tok_approve'),
        installments.createPlanForSession(s.checkoutSessionId, s.clientSecret, {
          count: 3,
          scenario: 'approve',
          acceptTerms: true,
        }),
      ]);
      const o = await orders.get(org, order.id);
      const paid = o.payment.state === 'paid';
      const planned = o.installments?.status === 'approved';
      expect(paid && planned).toBe(false);
      expect(paid || planned).toBe(true);
      expect(card.status === 'fulfilled' && paid ? 1 : 0).toBeLessThanOrEqual(1);
      expect(plan.status === 'fulfilled').toBe(planned);
    }
  });

  it('rechazado ⇒ libera la venta (la tarjeta cobra); pendiente ⇒ decisión simulada explícita', async () => {
    const { order, s } = await orderWithSession(8_000n);
    const declined = await installments.createPlanForSession(s.checkoutSessionId, s.clientSecret, {
      count: 4,
      scenario: 'decline',
      acceptTerms: true,
    });
    expect(declined.plan.status).toBe('declined');
    await checkout.confirmByClientSecret(s.checkoutSessionId, s.clientSecret, 'tok_approve');
    expect((await orders.get(org, order.id)).payment.state).toBe('paid');

    const p = await orderWithSession(8_000n);
    const pending = await installments.createPlanForSession(
      p.s.checkoutSessionId,
      p.s.clientSecret,
      {
        count: 4,
        scenario: 'pending',
        acceptTerms: true,
      }
    );
    expect(pending.plan.status).toBe('pending');
    expect(pending.plan.decidedAt).toBeNull();
    // Pendiente también retiene la venta.
    const err = await checkout
      .confirmByClientSecret(p.s.checkoutSessionId, p.s.clientSecret, 'tok_approve')
      .catch((e: unknown) => e);
    expect(isInstallmentPlanActive(err)).toBe(true);
    const userId = randomUUID();
    const approved = await installments.simulateDecision(org, pending.plan.id, 'approved', userId);
    expect(approved.status).toBe('approved');
    // Idempotente / sin vuelta atrás.
    expect(
      (await installments.simulateDecision(org, pending.plan.id, 'approved', userId)).status
    ).toBe('approved');
    await expect(
      installments.simulateDecision(org, pending.plan.id, 'declined', userId)
    ).rejects.toBeInstanceOf(InstallmentInvalidStateError);
  });

  it('cuotas: solo eventos simulados explícitos, en orden; vencida y luego pagada', async () => {
    const { s } = await orderWithSession(9_000n);
    const { plan } = await installments.createPlanForSession(s.checkoutSessionId, s.clientSecret, {
      count: 3,
      scenario: 'approve',
      acceptTerms: true,
    });
    const u = randomUUID();
    // Sin eventos, nada cambia (ni por tiempo): todo «scheduled».
    expect(
      (await installments.get(org, plan.id)).installments.every((i) => i.status === 'scheduled')
    ).toBe(true);
    // Fuera de orden ⇒ inválido.
    await expect(
      installments.simulateInstallment(org, plan.id, 2, 'paid', u)
    ).rejects.toBeInstanceOf(InstallmentInvalidStateError);
    await installments.simulateInstallment(org, plan.id, 1, 'paid', u);
    const overdue = await installments.simulateInstallment(org, plan.id, 2, 'overdue', u);
    expect(overdue.installments.map((i) => i.status)).toEqual([
      'paid_simulated',
      'overdue_simulated',
      'scheduled',
    ]);
    // Repetir es idempotente.
    await installments.simulateInstallment(org, plan.id, 2, 'overdue', u);
    const paid = await installments.simulateInstallment(org, plan.id, 2, 'paid', u);
    expect(paid.installments[1]!.status).toBe('paid_simulated');
    // El motor impide cambiar importes o fechas.
    await expect(
      withTenantTransaction(ctx.app, org, (c) =>
        c.query(`UPDATE sandbox_installments SET amount = 1 WHERE plan_id = $1 AND seq = 3`, [
          plan.id,
        ])
      )
    ).rejects.toThrow(/FLUVIA_IMMUTABLE/);
    // Aislamiento: otra organización no ve ni opera el plan.
    await expect(installments.get(orgB, plan.id)).rejects.toThrow();
    await expect(installments.simulateInstallment(orgB, plan.id, 3, 'paid', u)).rejects.toThrow();
  });

  it('vista del comprador con su client_secret; un secreto ajeno no ve nada', async () => {
    const { s } = await orderWithSession(3_000n);
    const view = await installments.buyerView(s.checkoutSessionId, s.clientSecret);
    expect(view?.eligible).toBe(true);
    expect(view?.order.total).toBe(3_000n);
    expect(view?.order.lines).toHaveLength(1);
    await expect(installments.buyerView(s.checkoutSessionId, 'cs_secret_wrong')).rejects.toThrow();
  });
});

describe('resumen: cobrado, en curso y simulación nunca se mezclan', () => {
  it('separa cobros confirmados, en curso, pedidos sin cobrar y planes simulados', async () => {
    const t = await ctx.createTenant(`Sum ${randomUUID().slice(0, 8)}`);
    const m = await ctx.admin.query<{ id: string }>(
      `INSERT INTO merchants (tenant_id, name) VALUES ($1, 'S') RETURNING id`,
      [t]
    );
    const p = await catalog.createProduct(t, { name: 'X', price: 1_000n, currency: 'USD' });
    const mk = () =>
      withTenantTransaction(ctx.app, t, (c) =>
        orders.createIn(c, t, {
          merchantId: m.rows[0]!.id,
          currency: 'USD',
          lines: [{ productId: p.id, quantity: 1 }],
          expectedTotal: 1_000n,
        })
      );
    const paid = await mk();
    const inflight = await mk();
    const plan = await mk();
    await mk(); // sin cobrar
    const s1 = await links.createSessionFromLink(paid.paymentLinkId);
    await checkout.confirmByClientSecret(s1.checkoutSessionId, s1.clientSecret, 'tok_approve');
    const s2 = await links.createSessionFromLink(inflight.paymentLinkId);
    await checkout.confirmByClientSecret(s2.checkoutSessionId, s2.clientSecret, 'tok_pse');
    const s3 = await links.createSessionFromLink(plan.paymentLinkId);
    await installments.createPlanForSession(s3.checkoutSessionId, s3.clientSecret, {
      count: 4,
      scenario: 'approve',
      acceptTerms: true,
    });

    const from = new Date(Date.now() - 3_600_000);
    const to = new Date(Date.now() + 3_600_000);
    const sum = await summary.summary(t, from, to);
    expect(sum.confirmed).toEqual([{ currency: 'USD', count: 1, amount: 1_000n }]);
    expect(sum.inFlight).toEqual([{ currency: 'USD', count: 1, amount: 1_000n }]);
    expect(sum.orders).toEqual([{ currency: 'USD', count: 4, amount: 4_000n }]);
    // Sin cobrar = el del plan simulado + el que no tiene checkout.
    expect(sum.ordersAwaitingPayment).toEqual([{ currency: 'USD', count: 2, amount: 2_000n }]);
    expect(sum.installmentsSandbox).toEqual([{ currency: 'USD', count: 1, amount: 1_000n }]);

    const cash = await summary.cash(t, from, to);
    expect(cash.confirmedByChannel).toEqual([
      { currency: 'USD', count: 1, amount: 1_000n, channel: 'pos_order' },
    ]);
    expect(cash.net).toEqual([{ currency: 'USD', amount: 1_000n }]);

    // Otra organización no ve nada de esto.
    const other = await summary.summary(orgB, from, to);
    expect(other.confirmed).toEqual([]);
  });
});
