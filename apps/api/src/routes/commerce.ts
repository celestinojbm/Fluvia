import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { PoolClient } from '@fluvia/db';
import { insertAuditEvent, type AuditAction, type AuditContext } from '@fluvia/audit';
import {
  IdempotencyService,
  assertValidIdempotencyKey,
  computeRequestHash,
} from '@fluvia/idempotency';
import {
  INSTALLMENT_DEMO_TERMS,
  INSTALLMENT_SCENARIOS,
  OrderNotFoundError,
  ORDER_MAX_LINES,
  ORDER_MAX_QUANTITY,
  type BuyerInstallmentsView,
  type CashSummary,
  type CatalogService,
  type CategoryDto,
  type CommerceSummary,
  type CurrencyFigure,
  type CustomerCardDto,
  type CustomerDirectory,
  type InstallmentPlanDto,
  type InstallmentQuote,
  type InstallmentSandboxService,
  type OrderDetailDto,
  type OrderDto,
  type OrderPaymentState,
  type OrderService,
  type ProductDto,
  type SummaryService,
} from '@fluvia/commerce';
import { CheckoutSessionNotFoundError } from '@fluvia/payments-core';
import type { Security } from '../security.js';

/**
 * Plataforma del comercio (sandbox) — plano de SESIÓN (operador humano) y
 * plano del COMPRADOR (client_secret de su checkout).
 *
 * Permisos (RBAC existente, sin roles nuevos):
 *  - Lectura: `payments:read` (todo rol).
 *  - Catálogo (crear/editar): `merchants:write` (owner/admin).
 *  - Vender (pedidos), clientes y eventos simulados de cuotas:
 *    `reconciliation:manage` (owner/admin/finance) — los mismos roles que ya
 *    crean ventas y devoluciones en el POS.
 * Toda escritura queda auditada como actor `user` en la MISMA transacción.
 * Importes: enteros en unidades menores (número JSON, ≤ entero seguro).
 */

const OrgParam = z.object({ orgId: z.string().uuid() });
const IdParams = z.object({ orgId: z.string().uuid(), id: z.string().uuid() });
const SessionParam = z.object({ id: z.string().uuid() });
const Currency = z.string().regex(/^[A-Z]{3}$/);
const MinorAmount = z
  .number()
  .int()
  .positive()
  .refine(Number.isSafeInteger, 'amount out of safe range');

const ProductQuery = z
  .object({
    q: z.string().trim().max(120).optional(),
    category_id: z.string().uuid().optional(),
    sellable: z.enum(['true', 'false']).optional(),
    include_archived: z.enum(['true', 'false']).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  })
  .passthrough();

const CreateCategoryBody = z.object({ name: z.string().trim().min(1).max(60) }).strict();
const CreateProductBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    sku: z.string().trim().min(1).max(64).nullable().optional(),
    description: z.string().trim().max(500).nullable().optional(),
    category_id: z.string().uuid().nullable().optional(),
    price: MinorAmount,
    currency: Currency,
    available: z.boolean().optional(),
  })
  .strict();
const UpdateProductBody = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    sku: z.string().trim().min(1).max(64).nullable().optional(),
    description: z.string().trim().max(500).nullable().optional(),
    category_id: z.string().uuid().nullable().optional(),
    price: MinorAmount.optional(),
    available: z.boolean().optional(),
    archived: z.boolean().optional(),
    expected_version: z.number().int().min(1),
  })
  .strict();

const CreateOrderBody = z
  .object({
    merchant_id: z.string().uuid(),
    currency: Currency,
    customer_id: z.string().uuid().nullable().optional(),
    note: z.string().trim().max(280).nullable().optional(),
    expected_total: MinorAmount,
    lines: z
      .array(
        z
          .object({
            product_id: z.string().uuid(),
            quantity: z.number().int().min(1).max(ORDER_MAX_QUANTITY),
          })
          .strict()
      )
      .min(1)
      .max(ORDER_MAX_LINES)
      .refine(
        (ls) => new Set(ls.map((l) => l.product_id)).size === ls.length,
        'each product appears once; use quantity'
      ),
  })
  .strict();
const ORDER_STATES: readonly OrderPaymentState[] = [
  'awaiting_payment',
  'payment_in_progress',
  'paid',
  'partially_refunded',
  'refunded',
];
const OrdersQuery = z
  .object({
    q: z.string().trim().max(120).optional(),
    state: z.enum(ORDER_STATES as unknown as [string, ...string[]]).optional(),
    customer_id: z.string().uuid().optional(),
    before_number: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .passthrough();

const CustomerFieldsBody = z
  .object({
    name: z.string().trim().min(1).max(200).nullable().optional(),
    email: z.string().trim().email().max(254).nullable().optional(),
    phone: z.string().trim().min(1).max(40).nullable().optional(),
    description: z.string().trim().min(1).max(500).nullable().optional(),
  })
  .strict();
const CreateCustomerBody = CustomerFieldsBody.refine(
  (c) => !!(c.name || c.email || c.phone),
  'a customer requires at least one of: name, email, phone'
);
const UpdateCustomerBody = CustomerFieldsBody.refine(
  (c) => Object.keys(c).length > 0,
  'update requires at least one field'
);
const CustomersQuery = z
  .object({
    q: z.string().trim().max(120).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .passthrough();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const PeriodQuery = z
  .object({
    from: z.string().regex(ISO_DATE).optional(),
    to: z.string().regex(ISO_DATE).optional(),
  })
  .passthrough()
  .refine((p) => !p.from || !p.to || p.from <= p.to, 'from must be <= to');

const SimulateDecisionBody = z.object({ decision: z.enum(['approved', 'declined']) }).strict();
const SimulateInstallmentBody = z.object({ outcome: z.enum(['paid', 'overdue']) }).strict();
const SeqParams = IdParams.extend({ seq: z.coerce.number().int().min(1).max(12) });

const QuoteBody = z.object({ count: z.number().int() }).strict();
const CreatePlanBody = z
  .object({
    count: z.number().int(),
    scenario: z.enum(INSTALLMENT_SCENARIOS as unknown as [string, ...string[]]),
    accept_terms: z.literal(true),
  })
  .strict();

// ── Serializers (whitelist explícita) ────────────────────────────────────────

const n = (v: bigint) => Number(v);

export function publicProduct(p: ProductDto) {
  return {
    id: p.id,
    object: 'product',
    name: p.name,
    sku: p.sku,
    description: p.description,
    category_id: p.categoryId,
    category_name: p.categoryName,
    price: n(p.price),
    currency: p.currency,
    available: p.available,
    archived: p.archived,
    version: p.version,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
  };
}

function publicCategory(c: CategoryDto) {
  return {
    id: c.id,
    object: 'category',
    name: c.name,
    product_count: c.productCount,
    created_at: c.createdAt,
  };
}

function publicInstallmentsSummary(o: OrderDto) {
  return o.installments
    ? {
        plan_id: o.installments.planId,
        status: o.installments.status,
        installments_count: o.installments.installmentsCount,
        paid_count: o.installments.paidCount,
        overdue_count: o.installments.overdueCount,
        simulated: true as const,
      }
    : null;
}

export function publicOrder(o: OrderDto) {
  return {
    id: o.id,
    object: 'order',
    number: o.number,
    merchant_id: o.merchantId,
    merchant_name: o.merchantName,
    customer_id: o.customerId,
    customer_name: o.customerName,
    currency: o.currency,
    total: n(o.total),
    line_count: o.lineCount,
    note: o.note,
    payment_link_id: o.paymentLinkId,
    created_by_user_id: o.createdByUserId,
    created_at: o.createdAt,
    payment: {
      state: o.payment.state,
      payment_intent_id: o.payment.paymentIntentId,
      intent_status: o.payment.intentStatus,
      amount_refunded: n(o.payment.amountRefunded),
      checkout_count: o.payment.checkoutCount,
      latest_checkout_session_id: o.payment.latestSessionId,
      latest_intent_status: o.payment.latestIntentStatus,
    },
    installments_sandbox: publicInstallmentsSummary(o),
  };
}

function publicLines(lines: OrderDetailDto['lines']) {
  return lines.map((l) => ({
    position: l.position,
    product_id: l.productId,
    name: l.name,
    sku: l.sku,
    unit_price: n(l.unitPrice),
    quantity: l.quantity,
    line_total: n(l.lineTotal),
  }));
}

export function publicOrderDetail(o: OrderDetailDto) {
  return { ...publicOrder(o), lines: publicLines(o.lines) };
}

function publicCustomer(c: CustomerCardDto) {
  return {
    id: c.id,
    object: 'customer',
    name: c.name,
    email: c.email,
    phone: c.phone,
    description: c.description,
    order_count: c.orderCount,
    last_order_at: c.lastOrderAt,
    created_at: c.createdAt,
    updated_at: c.updatedAt,
  };
}

function figures(list: CurrencyFigure[]) {
  return list.map((f) => ({ currency: f.currency, count: f.count, amount: n(f.amount) }));
}

function publicSummary(s: CommerceSummary) {
  return {
    object: 'commerce_summary',
    period: { start: s.periodStart, end: s.periodEnd, timezone: 'UTC' },
    confirmed_charges: figures(s.confirmed),
    charges_in_flight: figures(s.inFlight),
    refunds_confirmed: figures(s.refundsConfirmed),
    refunds_open: figures(s.refundsOpen),
    orders_created: figures(s.orders),
    orders_awaiting_payment: figures(s.ordersAwaitingPayment),
    installments_sandbox_approved: figures(s.installmentsSandbox),
  };
}

function publicCash(s: CashSummary) {
  return {
    object: 'cash_summary',
    period: { start: s.periodStart, end: s.periodEnd, timezone: 'UTC' },
    confirmed_by_channel: s.confirmedByChannel.map((f) => ({
      channel: f.channel,
      currency: f.currency,
      count: f.count,
      amount: n(f.amount),
    })),
    refunds_by_status: s.refundsByStatus.map((f) => ({
      status: f.status,
      currency: f.currency,
      count: f.count,
      amount: n(f.amount),
    })),
    net_operational: s.net.map((x) => ({ currency: x.currency, amount: n(x.amount) })),
    installments_sandbox_by_status: s.installmentsSandboxByStatus.map((f) => ({
      status: f.status,
      currency: f.currency,
      count: f.count,
      amount: n(f.amount),
    })),
  };
}

export function publicPlan(p: InstallmentPlanDto) {
  return {
    id: p.id,
    object: 'installment_plan',
    simulated: true as const,
    order_id: p.orderId,
    order_number: p.orderNumber,
    checkout_session_id: p.checkoutSessionId,
    currency: p.currency,
    total: n(p.total),
    installments_count: p.installmentsCount,
    interval_days: p.intervalDays,
    terms_version: p.termsVersion,
    scenario: p.scenario,
    status: p.status,
    buyer_confirmed_at: p.buyerConfirmedAt,
    decided_at: p.decidedAt,
    created_at: p.createdAt,
    installments: p.installments.map((i) => ({
      seq: i.seq,
      amount: n(i.amount),
      due_date: i.dueDate,
      status: i.status,
      status_changed_at: i.statusChangedAt,
    })),
    events: p.events.map((e) => ({
      kind: e.kind,
      seq: e.seq,
      actor: e.actor,
      created_at: e.createdAt,
    })),
  };
}

function publicQuote(q: InstallmentQuote) {
  return {
    object: 'installment_quote',
    simulated: true as const,
    count: q.count,
    currency: q.currency,
    total: n(q.total),
    initial_amount: n(q.initialAmount),
    interval_days: q.intervalDays,
    terms_version: q.termsVersion,
    interest_rate: INSTALLMENT_DEMO_TERMS.interestRate,
    fees: INSTALLMENT_DEMO_TERMS.fees,
    schedule: q.schedule.map((s) => ({ seq: s.seq, amount: n(s.amount), due_date: s.dueDate })),
  };
}

function publicBuyerView(v: BuyerInstallmentsView) {
  return {
    object: 'checkout_order',
    order: {
      number: v.order.number,
      merchant_name: v.order.merchantName,
      currency: v.order.currency,
      total: n(v.order.total),
      lines: publicLines(v.order.lines).map((l) => ({
        position: l.position,
        name: l.name,
        unit_price: l.unit_price,
        quantity: l.quantity,
        line_total: l.line_total,
      })),
    },
    installments: {
      simulated: true as const,
      eligible: v.eligible,
      ineligible_reason: v.ineligibleReason,
      allowed_counts: v.allowedCounts,
      interval_days: INSTALLMENT_DEMO_TERMS.intervalDays,
      terms_version: INSTALLMENT_DEMO_TERMS.version,
      plan: v.plan ? publicPlan(v.plan) : null,
    },
  };
}

function clientSecretOf(req: FastifyRequest): string {
  const raw = req.headers['x-checkout-client-secret'];
  const v = Array.isArray(raw) ? raw[0] : raw;
  // Ausente o de tamaño absurdo = el mismo 404 que un secreto incorrecto.
  if (typeof v !== 'string' || v.length < 1 || v.length > 200) {
    throw new CheckoutSessionNotFoundError();
  }
  return v;
}

/** Periodo [from, to] en días UTC; por defecto, hoy. `to` es inclusivo. */
function period(q: { from?: string; to?: string }): { from: Date; to: Date } {
  const today = new Date().toISOString().slice(0, 10);
  const from = new Date(`${q.from ?? q.to ?? today}T00:00:00.000Z`);
  const toDay = new Date(`${q.to ?? q.from ?? today}T00:00:00.000Z`);
  const to = new Date(toDay.getTime() + 86_400_000);
  if (to.getTime() - from.getTime() > 366 * 86_400_000) {
    throw new z.ZodError([
      { code: 'custom', path: ['to'], message: 'period longer than 366 days' },
    ]);
  }
  return { from, to };
}

export interface CommerceRoutesOptions {
  security: Security;
  idempotencyService: IdempotencyService;
  catalogService: CatalogService;
  orderService: OrderService;
  customerDirectory: CustomerDirectory;
  summaryService: SummaryService;
  installmentService: InstallmentSandboxService;
}

export function registerCommerceRoutes(
  app: FastifyInstance,
  {
    security,
    idempotencyService,
    catalogService,
    orderService,
    customerDirectory,
    summaryService,
    installmentService,
  }: CommerceRoutesOptions
): void {
  const read = { preHandler: [security.session, security.org('payments:read')] };
  const catalogWrite = { preHandler: [security.session, security.org('merchants:write')] };
  const sell = { preHandler: [security.session, security.org('reconciliation:manage')] };
  const tenant = (req: { org?: { organizationId: string } }) => req.org!.organizationId;
  const ctxOf = (req: FastifyRequest): AuditContext => ({
    actorType: 'user',
    actorId: req.identity!.userId,
    authMethod: 'session',
    requestId: String(req.id),
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  });
  const auditor =
    <T>(
      req: FastifyRequest,
      action: AuditAction,
      resourceType: string,
      idOf: (t: T) => string,
      after: (t: T) => Record<string, unknown>
    ) =>
    (c: PoolClient, value: T) =>
      insertAuditEvent(c, {
        action,
        tenantId: tenant(req),
        context: ctxOf(req),
        resourceType,
        resourceId: idOf(value),
        riskLevel: 'low',
        reason: 'commerce sandbox: operator action from the dashboard (session plane)',
        after: after(value),
      });

  // ── Catálogo ───────────────────────────────────────────────────────────────
  app.get('/v1/organizations/:orgId/catalog/categories', read, async (req) => {
    OrgParam.parse(req.params);
    const list = await catalogService.listCategories(tenant(req));
    return { object: 'list', data: list.map(publicCategory) };
  });

  app.post('/v1/organizations/:orgId/catalog/categories', catalogWrite, async (req, reply) => {
    OrgParam.parse(req.params);
    const { name } = CreateCategoryBody.parse(req.body);
    const created = await catalogService.createCategory(
      tenant(req),
      name,
      auditor<CategoryDto>(
        req,
        'catalog_category.created',
        'catalog_category',
        (c) => c.id,
        (c) => ({
          name: c.name,
        })
      )
    );
    return reply.code(201).send(publicCategory(created));
  });

  app.get('/v1/organizations/:orgId/catalog/products', read, async (req) => {
    OrgParam.parse(req.params);
    const q = ProductQuery.parse(req.query ?? {});
    const list = await catalogService.listProducts(tenant(req), {
      q: q.q,
      categoryId: q.category_id,
      sellableOnly: q.sellable === 'true',
      includeArchived: q.include_archived === 'true',
      limit: q.limit,
    });
    return { object: 'list', data: list.map(publicProduct) };
  });

  app.get('/v1/organizations/:orgId/catalog/products/:id', read, async (req) => {
    const { id } = IdParams.parse(req.params);
    return publicProduct(await catalogService.getProduct(tenant(req), id));
  });

  const productAfter = (p: ProductDto) => ({
    name: p.name,
    sku: p.sku,
    price: n(p.price),
    currency: p.currency,
    available: p.available,
    archived: p.archived,
    version: p.version,
  });

  app.post('/v1/organizations/:orgId/catalog/products', catalogWrite, async (req, reply) => {
    OrgParam.parse(req.params);
    const b = CreateProductBody.parse(req.body);
    const created = await catalogService.createProduct(
      tenant(req),
      {
        name: b.name,
        sku: b.sku ?? null,
        description: b.description ?? null,
        categoryId: b.category_id ?? null,
        price: BigInt(b.price),
        currency: b.currency,
        available: b.available,
      },
      auditor(req, 'catalog_product.created', 'catalog_product', (p) => p.id, productAfter)
    );
    return reply.code(201).send(publicProduct(created));
  });

  app.patch('/v1/organizations/:orgId/catalog/products/:id', catalogWrite, async (req) => {
    const { id } = IdParams.parse(req.params);
    const b = UpdateProductBody.parse(req.body);
    const updated = await catalogService.updateProduct(
      tenant(req),
      id,
      {
        name: b.name,
        sku: b.sku,
        description: b.description,
        categoryId: b.category_id,
        price: b.price === undefined ? undefined : BigInt(b.price),
        available: b.available,
        archived: b.archived,
        expectedVersion: b.expected_version,
      },
      auditor(req, 'catalog_product.updated', 'catalog_product', (p) => p.id, productAfter)
    );
    return publicProduct(updated);
  });

  // ── Pedidos (ventas con líneas) ────────────────────────────────────────────
  app.get('/v1/organizations/:orgId/orders', read, async (req) => {
    OrgParam.parse(req.params);
    const q = OrdersQuery.parse(req.query ?? {});
    const page = await orderService.list(tenant(req), {
      q: q.q,
      state: q.state as OrderPaymentState | undefined,
      customerId: q.customer_id,
      beforeNumber: q.before_number,
      limit: q.limit,
    });
    const last = page.data[page.data.length - 1];
    return {
      object: 'list',
      data: page.data.map(publicOrder),
      has_more: page.hasMore,
      next_before_number: page.hasMore && last ? last.number : null,
    };
  });

  app.get('/v1/organizations/:orgId/orders/:id', read, async (req) => {
    const { id } = IdParams.parse(req.params);
    return publicOrderDetail(await orderService.get(tenant(req), id));
  });

  // Pedido de una venta (payment link): el POS lo usa para mostrar el detalle
  // del pedido que está cobrando. Una venta sin pedido (importe libre) ⇒ 404.
  app.get('/v1/organizations/:orgId/payment_links/:id/order', read, async (req) => {
    const { id } = IdParams.parse(req.params);
    const order = await orderService.findByLink(tenant(req), id);
    if (!order) throw new OrderNotFoundError();
    return publicOrderDetail(order);
  });

  // Crear el pedido = calcular el total en servidor + crear su venta de cobro
  // único, idempotente por `Idempotency-Key` (un reenvío devuelve el MISMO
  // pedido) y auditado en la misma transacción.
  app.post('/v1/organizations/:orgId/orders', sell, async (req, reply) => {
    OrgParam.parse(req.params);
    const key = assertValidIdempotencyKey(req.headers['idempotency-key']);
    const body = CreateOrderBody.parse(req.body);
    const tenantId = tenant(req);
    const context = ctxOf(req);
    const result = await idempotencyService.execute({
      tenantId,
      endpoint: 'POST /v1/organizations/:orgId/orders',
      key,
      requestHash: computeRequestHash(body),
      handler: async (client) => {
        const order = await orderService.createIn(client, tenantId, {
          merchantId: body.merchant_id,
          currency: body.currency,
          customerId: body.customer_id ?? null,
          note: body.note ?? null,
          expectedTotal: BigInt(body.expected_total),
          lines: body.lines.map((l) => ({ productId: l.product_id, quantity: l.quantity })),
          createdByUserId: req.identity!.userId,
        });
        const serialized = publicOrderDetail(order);
        await insertAuditEvent(client, {
          action: 'order.created',
          tenantId,
          context,
          resourceType: 'order',
          resourceId: order.id,
          riskLevel: 'medium',
          reason: 'order created from the dashboard (session plane)',
          after: {
            number: serialized.number,
            merchant_id: serialized.merchant_id,
            total: serialized.total,
            currency: serialized.currency,
            line_count: serialized.line_count,
            payment_link_id: serialized.payment_link_id,
          },
        });
        return { status: 201, body: serialized };
      },
    });
    reply.header('idempotency-replayed', String(result.replayed));
    return reply.code(result.status).send(result.body);
  });

  // ── Clientes (ficha mínima, datos sintéticos en la demo) ───────────────────
  app.get('/v1/organizations/:orgId/customers', read, async (req) => {
    OrgParam.parse(req.params);
    const q = CustomersQuery.parse(req.query ?? {});
    const list = await customerDirectory.list(tenant(req), q.q, q.limit);
    return { object: 'list', data: list.map(publicCustomer) };
  });

  app.get('/v1/organizations/:orgId/customers/:id', read, async (req) => {
    const { id } = IdParams.parse(req.params);
    const [customer, orders] = await Promise.all([
      customerDirectory.get(tenant(req), id),
      orderService.list(tenant(req), { customerId: id, limit: 50 }),
    ]);
    return {
      ...publicCustomer(customer),
      orders: orders.data.map(publicOrder),
      orders_has_more: orders.hasMore,
    };
  });

  const customerAfter = (c: CustomerCardDto) => ({
    has_name: c.name !== null,
    has_email: c.email !== null,
    has_phone: c.phone !== null,
  });

  app.post('/v1/organizations/:orgId/customers', sell, async (req, reply) => {
    OrgParam.parse(req.params);
    const b = CreateCustomerBody.parse(req.body);
    const created = await customerDirectory.create(
      tenant(req),
      b,
      auditor(req, 'customer.created', 'customer', (c) => c.id, customerAfter)
    );
    return reply.code(201).send(publicCustomer(created));
  });

  app.patch('/v1/organizations/:orgId/customers/:id', sell, async (req) => {
    const { id } = IdParams.parse(req.params);
    const b = UpdateCustomerBody.parse(req.body);
    const updated = await customerDirectory.update(
      tenant(req),
      id,
      b,
      auditor(req, 'customer.updated', 'customer', (c) => c.id, customerAfter)
    );
    return publicCustomer(updated);
  });

  // ── Indicadores y caja ─────────────────────────────────────────────────────
  app.get('/v1/organizations/:orgId/commerce/summary', read, async (req) => {
    OrgParam.parse(req.params);
    const { from, to } = period(PeriodQuery.parse(req.query ?? {}));
    return publicSummary(await summaryService.summary(tenant(req), from, to));
  });

  app.get('/v1/organizations/:orgId/commerce/cash', read, async (req) => {
    OrgParam.parse(req.params);
    const { from, to } = period(PeriodQuery.parse(req.query ?? {}));
    return publicCash(await summaryService.cash(tenant(req), from, to));
  });

  // ── Cuotas SANDBOX (comercio) ──────────────────────────────────────────────
  app.get('/v1/organizations/:orgId/installment_plans', read, async (req) => {
    OrgParam.parse(req.params);
    const list = await installmentService.list(tenant(req), 50);
    return { object: 'list', simulated: true, data: list.map(publicPlan) };
  });

  app.get('/v1/organizations/:orgId/installment_plans/:id', read, async (req) => {
    const { id } = IdParams.parse(req.params);
    return publicPlan(await installmentService.get(tenant(req), id));
  });

  const planAfter = (p: InstallmentPlanDto) => ({
    status: p.status,
    installments: p.installments.map((i) => i.status),
    simulated: true,
  });

  app.post(
    '/v1/organizations/:orgId/installment_plans/:id/simulate_decision',
    sell,
    async (req) => {
      const { id } = IdParams.parse(req.params);
      const { decision } = SimulateDecisionBody.parse(req.body);
      const plan = await installmentService.simulateDecision(
        tenant(req),
        id,
        decision,
        req.identity!.userId,
        auditor(req, 'installment_plan.simulated_event', 'installment_plan', (p) => p.id, planAfter)
      );
      return publicPlan(plan);
    }
  );

  app.post(
    '/v1/organizations/:orgId/installment_plans/:id/installments/:seq/simulate',
    sell,
    async (req) => {
      const { id, seq } = SeqParams.parse(req.params);
      const { outcome } = SimulateInstallmentBody.parse(req.body);
      const plan = await installmentService.simulateInstallment(
        tenant(req),
        id,
        seq,
        outcome,
        req.identity!.userId,
        auditor(req, 'installment_plan.simulated_event', 'installment_plan', (p) => p.id, planAfter)
      );
      return publicPlan(plan);
    }
  );

  // ── Comprador (credencial: client_secret de SU checkout) ───────────────────
  // Resumen del pedido (líneas) + opción de cuotas simulada + plan vigente.
  // Un checkout sin pedido (venta de importe libre) ⇒ 404.
  app.get('/v1/checkout_sessions/:id/order', async (req) => {
    const { id } = SessionParam.parse(req.params);
    const view = await installmentService.buyerView(id, clientSecretOf(req));
    if (!view) throw new OrderNotFoundError();
    return publicBuyerView(view);
  });

  app.post('/v1/checkout_sessions/:id/installments/quote', async (req) => {
    const { id } = SessionParam.parse(req.params);
    const { count } = QuoteBody.parse(req.body);
    return publicQuote(await installmentService.quoteForSession(id, clientSecretOf(req), count));
  });

  // Confirmación EXPLÍCITA del comprador (`accept_terms: true` obligatorio).
  // Reenvío idéntico ⇒ el mismo plan (200, replayed); creación ⇒ 201.
  app.post('/v1/checkout_sessions/:id/installments', async (req, reply) => {
    const { id } = SessionParam.parse(req.params);
    const b = CreatePlanBody.parse(req.body);
    const { plan, replayed } = await installmentService.createPlanForSession(
      id,
      clientSecretOf(req),
      { count: b.count, scenario: b.scenario as never, acceptTerms: b.accept_terms }
    );
    reply.header('idempotency-replayed', String(replayed));
    return reply.code(replayed ? 200 : 201).send(publicPlan(plan));
  });
}
