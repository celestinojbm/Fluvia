import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@fluvia/config';
import { createPool, type Pool } from '@fluvia/db';
import { AuthService } from '@fluvia/auth';
import { ApiKeyService, IdentityService } from '@fluvia/identity';
import { buildApp } from '../src/app.js';

/**
 * Plataforma del comercio por HTTP contra PostgreSQL real: permisos del RBAC
 * existente, aislamiento por organización, idempotencia de la venta,
 * auditoría, el plano del comprador (client_secret) y la guarda de doble
 * cobro tarjeta ↔ cuotas simuladas.
 */

let app: FastifyInstance;
let appPool: Pool;
let authPool: Pool;
let adminPool: Pool;
let orgA: string;
let orgB: string;
let merchantA: string;

const PASSWORD = 'commerce password 77';

async function sessionUser(role: string, orgId: string) {
  const email = `com-${randomUUID().slice(0, 12)}@example.com`;
  const reg = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email, password: PASSWORD },
  });
  const { user_id, verification_token } = reg.json();
  await app.inject({
    method: 'POST',
    url: '/v1/auth/verify-email',
    payload: { token: verification_token },
  });
  await adminPool.query('INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)', [
    orgId,
    user_id,
    role,
  ]);
  const login = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email, password: PASSWORD },
  });
  return {
    userId: user_id as string,
    headers: { authorization: `Bearer ${login.json().session_token as string}` },
  };
}

async function createOrg(name: string): Promise<string> {
  const res = await adminPool.query<{ id: string }>(
    'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id',
    [name, `org-${randomUUID()}`]
  );
  return res.rows[0]!.id;
}

type Headers = Record<string, string>;
let owner: { userId: string; headers: Headers };
let finance: { userId: string; headers: Headers };
let readOnly: { userId: string; headers: Headers };
let ownerB: { userId: string; headers: Headers };

beforeAll(async () => {
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' });
  appPool = createPool({ connectionString: config.db.app, max: 6 });
  authPool = createPool({ connectionString: config.db.auth, max: 4 });
  adminPool = createPool({ connectionString: config.db.admin, max: 2 });
  app = buildApp({
    config,
    appPool,
    authService: new AuthService(authPool),
    identityService: new IdentityService(appPool),
    apiKeyService: new ApiKeyService(appPool),
    authRateLimits: {
      loginPerEmail: { max: 10_000, windowMs: 60_000 },
      loginPerIp: { max: 10_000, windowMs: 60_000 },
      registerPerIp: { max: 10_000, windowMs: 60_000 },
      mfaPerIp: { max: 10_000, windowMs: 60_000 },
    },
  });
  await app.ready();
  orgA = await createOrg('Commerce A');
  orgB = await createOrg('Commerce B');
  const m = await adminPool.query<{ id: string }>(
    `INSERT INTO merchants (tenant_id, name) VALUES ($1, 'Tienda A') RETURNING id`,
    [orgA]
  );
  merchantA = m.rows[0]!.id;
  owner = await sessionUser('owner', orgA);
  finance = await sessionUser('finance', orgA);
  readOnly = await sessionUser('read_only', orgA);
  ownerB = await sessionUser('owner', orgB);
}, 40_000);

afterAll(async () => {
  await app.close();
  await Promise.all([appPool.end(), authPool.end(), adminPool.end()]);
});

const base = (org: string) => `/v1/organizations/${org}`;

async function newProduct(price = 1_500, extra: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: 'POST',
    url: `${base(orgA)}/catalog/products`,
    headers: owner.headers,
    payload: { name: `Prod ${randomUUID().slice(0, 6)}`, price, currency: 'USD', ...extra },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; price: number; version: number; name: string };
}

async function newOrder(lines: Array<{ product_id: string; quantity: number }>, total: number) {
  const key = `ord-${randomUUID()}`;
  const res = await app.inject({
    method: 'POST',
    url: `${base(orgA)}/orders`,
    headers: { ...finance.headers, 'idempotency-key': key },
    payload: { merchant_id: merchantA, currency: 'USD', lines, expected_total: total },
  });
  return { res, key };
}

describe('permisos (RBAC existente)', () => {
  it('read_only lee el catálogo pero no lo edita ni vende', async () => {
    const p = await newProduct();
    const list = await app.inject({
      method: 'GET',
      url: `${base(orgA)}/catalog/products`,
      headers: readOnly.headers,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().data.map((x: { id: string }) => x.id)).toContain(p.id);

    const edit = await app.inject({
      method: 'PATCH',
      url: `${base(orgA)}/catalog/products/${p.id}`,
      headers: readOnly.headers,
      payload: { price: 1, expected_version: 1 },
    });
    expect(edit.statusCode).toBe(403);
    const sell = await app.inject({
      method: 'POST',
      url: `${base(orgA)}/orders`,
      headers: { ...readOnly.headers, 'idempotency-key': `k-${randomUUID()}` },
      payload: {
        merchant_id: merchantA,
        currency: 'USD',
        lines: [{ product_id: p.id, quantity: 1 }],
        expected_total: 1_500,
      },
    });
    expect(sell.statusCode).toBe(403);
  });

  it('finance vende pero no edita el catálogo (merchants:write)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${base(orgA)}/catalog/products`,
      headers: finance.headers,
      payload: { name: 'X', price: 1, currency: 'USD' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('sin sesión ⇒ 401; org ajena ⇒ 404 (indistinguible de inexistente)', async () => {
    const anon = await app.inject({ method: 'GET', url: `${base(orgA)}/orders` });
    expect(anon.statusCode).toBe(401);
    const other = await app.inject({
      method: 'GET',
      url: `${base(orgA)}/orders`,
      headers: ownerB.headers,
    });
    expect(other.statusCode).toBe(404);
  });
});

describe('venta: total en servidor, idempotencia y auditoría', () => {
  it('crea el pedido, un reenvío con la misma key devuelve el MISMO pedido', async () => {
    const a = await newProduct(1_250);
    const b = await newProduct(399);
    const lines = [
      { product_id: a.id, quantity: 2 },
      { product_id: b.id, quantity: 1 },
    ];
    const { res, key } = await newOrder(lines, 2_899);
    expect(res.statusCode).toBe(201);
    const order = res.json();
    expect(order.total).toBe(2_899);
    expect(order.lines).toHaveLength(2);
    expect(order.payment.state).toBe('awaiting_payment');

    const replay = await app.inject({
      method: 'POST',
      url: `${base(orgA)}/orders`,
      headers: { ...finance.headers, 'idempotency-key': key },
      payload: { merchant_id: merchantA, currency: 'USD', lines, expected_total: 2_899 },
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.json().id).toBe(order.id);
    const count = await adminPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM commerce_orders WHERE payment_link_id = $1`,
      [order.payment_link_id]
    );
    expect(count.rows[0]!.n).toBe(1);

    // Misma key con OTRO carrito ⇒ conflicto (no crea otra venta).
    const reuse = await app.inject({
      method: 'POST',
      url: `${base(orgA)}/orders`,
      headers: { ...finance.headers, 'idempotency-key': key },
      payload: {
        merchant_id: merchantA,
        currency: 'USD',
        lines: [lines[0]],
        expected_total: 2_500,
      },
    });
    expect(reuse.statusCode).toBe(422);
    expect(reuse.json().error.code).toBe('idempotency_key_reuse');

    const audit = await adminPool.query<{ action: string; actor_id: string }>(
      `SELECT action, actor_id FROM audit_events WHERE resource_id = $1`,
      [order.id]
    );
    expect(audit.rows).toEqual([{ action: 'order.created', actor_id: finance.userId }]);

    // Detalle, lista con búsqueda por número y pedido por venta (POS).
    const detail = await app.inject({
      method: 'GET',
      url: `${base(orgA)}/orders/${order.id}`,
      headers: readOnly.headers,
    });
    expect(detail.json().lines[0].unit_price).toBe(1_250);
    const search = await app.inject({
      method: 'GET',
      url: `${base(orgA)}/orders?q=%23${order.number}`,
      headers: readOnly.headers,
    });
    expect(search.json().data.map((o: { id: string }) => o.id)).toEqual([order.id]);
    const byLink = await app.inject({
      method: 'GET',
      url: `${base(orgA)}/payment_links/${order.payment_link_id}/order`,
      headers: readOnly.headers,
    });
    expect(byLink.json().id).toBe(order.id);
    const otherOrg = await app.inject({
      method: 'GET',
      url: `${base(orgB)}/orders/${order.id}`,
      headers: ownerB.headers,
    });
    expect(otherOrg.statusCode).toBe(404);
  });

  it('precio cambiado ⇒ 409 order_total_changed; edición concurrente ⇒ 409; no disponible ⇒ 422', async () => {
    const a = await newProduct(1_000);
    const edit = await app.inject({
      method: 'PATCH',
      url: `${base(orgA)}/catalog/products/${a.id}`,
      headers: owner.headers,
      payload: { price: 1_100, expected_version: 1 },
    });
    expect(edit.statusCode).toBe(200);
    const stale = await app.inject({
      method: 'PATCH',
      url: `${base(orgA)}/catalog/products/${a.id}`,
      headers: owner.headers,
      payload: { price: 1_200, expected_version: 1 },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('catalog_version_conflict');

    const { res } = await newOrder([{ product_id: a.id, quantity: 1 }], 1_000);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('order_total_changed');

    const off = await newProduct(500, { available: false });
    const { res: r2 } = await newOrder([{ product_id: off.id, quantity: 1 }], 500);
    expect(r2.statusCode).toBe(422);
    expect(r2.json().error.code).toBe('product_unavailable');

    const dup = await newOrder(
      [
        { product_id: a.id, quantity: 1 },
        { product_id: a.id, quantity: 1 },
      ],
      2_200
    );
    expect(dup.res.statusCode).toBe(400);
  });
});

describe('clientes', () => {
  it('crea, busca, edita y ve sus compras; otra org no los ve', async () => {
    const c = await app.inject({
      method: 'POST',
      url: `${base(orgA)}/customers`,
      headers: finance.headers,
      payload: { name: 'Ana Prueba', email: 'ana@example.test' },
    });
    expect(c.statusCode).toBe(201);
    const id = c.json().id as string;
    const p = await newProduct(800);
    const order = await app.inject({
      method: 'POST',
      url: `${base(orgA)}/orders`,
      headers: { ...finance.headers, 'idempotency-key': `o-${randomUUID()}` },
      payload: {
        merchant_id: merchantA,
        currency: 'USD',
        customer_id: id,
        lines: [{ product_id: p.id, quantity: 1 }],
        expected_total: 800,
      },
    });
    expect(order.json().customer_name).toBe('Ana Prueba');
    const search = await app.inject({
      method: 'GET',
      url: `${base(orgA)}/customers?q=ana`,
      headers: readOnly.headers,
    });
    expect(search.json().data.map((x: { id: string }) => x.id)).toContain(id);
    const card = await app.inject({
      method: 'GET',
      url: `${base(orgA)}/customers/${id}`,
      headers: readOnly.headers,
    });
    expect(card.json().order_count).toBe(1);
    expect(card.json().orders[0].id).toBe(order.json().id);
    const upd = await app.inject({
      method: 'PATCH',
      url: `${base(orgA)}/customers/${id}`,
      headers: finance.headers,
      payload: { phone: '+58 000 0000' },
    });
    expect(upd.json().phone).toBe('+58 000 0000');
    const b = await app.inject({
      method: 'GET',
      url: `${base(orgB)}/customers/${id}`,
      headers: ownerB.headers,
    });
    expect(b.statusCode).toBe(404);
  });
});

describe('comprador: resumen del pedido y cuotas simuladas', () => {
  it('vista, cotización, confirmación explícita, idempotencia y bloqueo del cobro con tarjeta', async () => {
    const p = await newProduct(10_000);
    const { res } = await newOrder([{ product_id: p.id, quantity: 1 }], 10_000);
    const order = res.json();
    const s = await app.inject({
      method: 'POST',
      url: `/v1/payment_links/${order.payment_link_id}/sessions`,
    });
    const { checkout_session_id: sid, client_secret: secret } = s.json();
    const h = { 'x-checkout-client-secret': secret };

    const view = await app.inject({
      method: 'GET',
      url: `/v1/checkout_sessions/${sid}/order`,
      headers: h,
    });
    expect(view.statusCode).toBe(200);
    expect(view.json().order.total).toBe(10_000);
    expect(view.json().installments.eligible).toBe(true);
    expect(view.json().installments.simulated).toBe(true);
    const bad = await app.inject({
      method: 'GET',
      url: `/v1/checkout_sessions/${sid}/order`,
      headers: { 'x-checkout-client-secret': 'nope' },
    });
    expect(bad.statusCode).toBe(404);

    const quote = await app.inject({
      method: 'POST',
      url: `/v1/checkout_sessions/${sid}/installments/quote`,
      headers: h,
      payload: { count: 3 },
    });
    expect(quote.json().schedule.map((x: { amount: number }) => x.amount)).toEqual([
      3_334, 3_333, 3_333,
    ]);
    expect(quote.json().interest_rate).toBe(0);

    const noAccept = await app.inject({
      method: 'POST',
      url: `/v1/checkout_sessions/${sid}/installments`,
      headers: h,
      payload: { count: 3, scenario: 'approve', accept_terms: false },
    });
    expect(noAccept.statusCode).toBe(400);

    const plan = await app.inject({
      method: 'POST',
      url: `/v1/checkout_sessions/${sid}/installments`,
      headers: h,
      payload: { count: 3, scenario: 'approve', accept_terms: true },
    });
    expect(plan.statusCode).toBe(201);
    expect(plan.json().status).toBe('approved');
    const again = await app.inject({
      method: 'POST',
      url: `/v1/checkout_sessions/${sid}/installments`,
      headers: h,
      payload: { count: 3, scenario: 'approve', accept_terms: true },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().id).toBe(plan.json().id);

    const card = await app.inject({
      method: 'POST',
      url: `/v1/checkout_sessions/${sid}/confirm`,
      headers: h,
      payload: { payment_method_token: 'tok_approve' },
    });
    expect(card.statusCode).toBe(409);
    expect(card.json().error.code).toBe('installment_plan_active');

    // El comercio ve el plan; el pedido NO figura como pagado.
    const o = await app.inject({
      method: 'GET',
      url: `${base(orgA)}/orders/${order.id}`,
      headers: readOnly.headers,
    });
    expect(o.json().payment.state).toBe('awaiting_payment');
    expect(o.json().installments_sandbox.status).toBe('approved');

    // Evento simulado: read_only no puede; finance sí (auditado).
    const planId = plan.json().id as string;
    const denied = await app.inject({
      method: 'POST',
      url: `${base(orgA)}/installment_plans/${planId}/installments/1/simulate`,
      headers: readOnly.headers,
      payload: { outcome: 'paid' },
    });
    expect(denied.statusCode).toBe(403);
    const paid = await app.inject({
      method: 'POST',
      url: `${base(orgA)}/installment_plans/${planId}/installments/1/simulate`,
      headers: finance.headers,
      payload: { outcome: 'paid' },
    });
    expect(paid.json().installments[0].status).toBe('paid_simulated');
    const outOfOrder = await app.inject({
      method: 'POST',
      url: `${base(orgA)}/installment_plans/${planId}/installments/3/simulate`,
      headers: finance.headers,
      payload: { outcome: 'paid' },
    });
    expect(outOfOrder.statusCode).toBe(409);
    const audit = await adminPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_events
       WHERE resource_id = $1 AND action = 'installment_plan.simulated_event'`,
      [planId]
    );
    expect(audit.rows[0]!.n).toBe(1);
    const other = await app.inject({
      method: 'GET',
      url: `${base(orgB)}/installment_plans/${planId}`,
      headers: ownerB.headers,
    });
    expect(other.statusCode).toBe(404);
  });
});

describe('indicadores', () => {
  it('summary y caja responden por moneda con periodo UTC declarado', async () => {
    const sum = await app.inject({
      method: 'GET',
      url: `${base(orgA)}/commerce/summary`,
      headers: readOnly.headers,
    });
    expect(sum.statusCode).toBe(200);
    expect(sum.json().period.timezone).toBe('UTC');
    expect(Array.isArray(sum.json().orders_created)).toBe(true);
    const cash = await app.inject({
      method: 'GET',
      url: `${base(orgA)}/commerce/cash?from=2026-01-01&to=2026-12-31`,
      headers: readOnly.headers,
    });
    expect(cash.statusCode).toBe(200);
    const bad = await app.inject({
      method: 'GET',
      url: `${base(orgA)}/commerce/cash?from=2026-12-31&to=2026-01-01`,
      headers: readOnly.headers,
    });
    expect(bad.statusCode).toBe(400);
  });
});
