import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@fluvia/config';
import { createPool, type Pool } from '@fluvia/db';
import { AuthService } from '@fluvia/auth';
import { ApiKeyService, IdentityService } from '@fluvia/identity';
import { InboxProcessor, signWebhookPayload } from '@fluvia/inbox';
import { LedgerService, PostingService } from '@fluvia/ledger';
import {
  DisputeService,
  MOCK_PROVIDER_NAME,
  MockPaymentProvider,
  PaymentConfirmationService,
  PaymentIntentService,
  PayoutService,
  ZERO_FEE_SCHEDULE,
  createMockInboxRegistration,
} from '@fluvia/payments-core';
import { buildApp } from '../src/app.js';

/**
 * Cuenta del restaurante contra PostgreSQL real y el flujo de cobro
 * EXISTENTE (link de cobro único → checkout → proveedor sandbox → webhook
 * firmado → inbox): cuenta completa y dividida (artículos, monto, partes
 * iguales con resto exacto), concurrencia entre cajeros, fracción incierta
 * que retiene, anulación sin cobro, y cierre como pagada SOLO tras verificar
 * en el servidor.
 */

let app: FastifyInstance;
let appPool: Pool;
let authPool: Pool;
let adminPool: Pool;
let inboxPool: Pool;
let processor: InboxProcessor;
let secret: string;
let org: string;
const PASSWORD = 'bills password 77';
type User = { userId: string; headers: Record<string, string> };

async function sessionUser(role: string): Promise<User> {
  const email = `bill-${randomUUID().slice(0, 12)}@example.com`;
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
    org,
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

const call = (u: User, method: 'GET' | 'POST' | 'PUT', path: string, payload?: unknown) =>
  app.inject({
    method,
    url: `/v1/organizations/${org}${path}`,
    headers: u.headers,
    payload: payload as never,
  });

let owner: User;
let cashier: User;
let cashier2: User;
let waiter: User;
let branch: string;
const products: Record<string, string> = {};

/** Cobra un link por el checkout alojado (plano público), como el comprador. */
async function pay(payUrl: string, token: 'tok_approve' | 'tok_decline' | 'tok_pse') {
  const linkId = payUrl.split('/l/')[1]!;
  const opened = await app.inject({ method: 'POST', url: `/v1/payment_links/${linkId}/sessions` });
  if (opened.statusCode !== 200 && opened.statusCode !== 201) return { opened, confirm: null };
  const { checkout_session_id, client_secret } = opened.json();
  const confirm = await app.inject({
    method: 'POST',
    url: `/v1/checkout_sessions/${checkout_session_id}/confirm`,
    headers: { 'x-checkout-client-secret': client_secret },
    payload: { payment_method_token: token },
  });
  return { opened, confirm, linkId };
}

async function settleByWebhook(linkId: string, type: 'payment.succeeded' | 'payment.failed') {
  const a = await adminPool.query<{ id: string; provider_ref: string }>(
    `SELECT a.id, a.provider_ref FROM payment_attempts a
       JOIN payment_intents i ON i.id = a.intent_id
      WHERE i.payment_link_id = $1 ORDER BY a.created_at DESC LIMIT 1`,
    [linkId]
  );
  const eventId = `evt-${randomUUID()}`;
  const body = JSON.stringify({
    event_id: eventId,
    type,
    tenant_id: org,
    attempt_id: a.rows[0]!.id,
    provider_ref: a.rows[0]!.provider_ref,
    ...(type === 'payment.failed' ? { failure_code: 'card_declined' } : {}),
  });
  const ts = Date.now();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/providers/mock/webhook',
    headers: {
      'x-fluvia-timestamp': String(ts),
      'x-fluvia-signature': signWebhookPayload(secret, ts, body),
      'content-type': 'application/json',
    },
    payload: body,
  });
  expect(res.statusCode).toBe(200);
  await drainEvent(eventId);
}

/**
 * Procesa el inbox hasta que ESTE evento deje de estar pendiente. Otros
 * archivos de prueba corren en paralelo sobre la misma BD con su propio
 * procesador: cualquiera puede reclamar el evento (SKIP LOCKED), así que un
 * solo `runOnce()` propio no garantiza haberlo aplicado.
 */
async function drainEvent(eventId: string) {
  for (let i = 0; i < 100; i++) {
    await processor.runOnce();
    const r = await adminPool.query<{ status: string }>(
      `SELECT status FROM provider_events WHERE provider_event_id = $1`,
      [eventId]
    );
    if (r.rows[0] && r.rows[0].status !== 'pending') return;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error(`el evento ${eventId} sigue pendiente tras 10 s`);
}

/** Pedido con las líneas dadas, enviado a cocina y con la cuenta pedida. */
async function orderWithBill(lines: Array<[string, number]>) {
  const o = await call(waiter, 'POST', '/dining/orders', { branch_id: branch, mode: 'takeaway' });
  const added = await call(waiter, 'POST', `/dining/orders/${o.json().id}/lines`, {
    expected_version: o.json().version,
    lines: lines.map(([p, q]) => ({ product_id: products[p], quantity: q })),
  });
  const sent = await call(waiter, 'POST', `/dining/orders/${o.json().id}/send`, {
    expected_version: added.json().version,
  });
  const req = await call(waiter, 'POST', `/dining/orders/${o.json().id}/request-bill`, {
    expected_version: sent.json().order.version,
  });
  expect(req.statusCode).toBe(200);
  return o.json().id as string;
}

beforeAll(async () => {
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' });
  secret = config.mockWebhookSecret;
  appPool = createPool({ connectionString: config.db.app, max: 10 });
  authPool = createPool({ connectionString: config.db.auth, max: 4 });
  adminPool = createPool({ connectionString: config.db.admin, max: 2 });
  inboxPool = createPool({ connectionString: config.db.inbox, max: 2 });
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
  // MISMO cableado del worker para aplicar webhooks.
  const intents = new PaymentIntentService(appPool);
  const posting = new PostingService(new LedgerService(appPool), appPool);
  const provider = new MockPaymentProvider();
  const confirmation = new PaymentConfirmationService(
    appPool,
    intents,
    posting,
    provider,
    ZERO_FEE_SCHEDULE
  );
  processor = new InboxProcessor(inboxPool, {});
  processor.register(
    MOCK_PROVIDER_NAME,
    createMockInboxRegistration(
      confirmation,
      new PayoutService(appPool, posting, provider),
      new DisputeService(appPool, posting)
    )
  );

  org = (
    await adminPool.query<{ id: string }>(
      'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id',
      ['Bills Org', `org-${randomUUID()}`]
    )
  ).rows[0]!.id;
  await adminPool.query(
    `INSERT INTO merchants (tenant_id, name, default_currency) VALUES ($1, 'Fonda', 'USD')`,
    [org]
  );
  owner = await sessionUser('owner');
  cashier = await sessionUser('staff');
  cashier2 = await sessionUser('staff');
  waiter = await sessionUser('staff');
  await call(owner, 'PUT', '/business-profile', {
    business_type: 'restaurant',
    expected_version: 0,
  });
  branch = (await call(owner, 'POST', '/venue/branches', { name: 'Centro' })).json().id;
  for (const [u, role] of [
    [cashier, 'cashier'],
    [cashier2, 'cashier'],
    [waiter, 'waiter'],
  ] as const) {
    await call(owner, 'POST', '/venue/staff', { user_id: u.userId, role, branch_id: branch });
  }
  for (const [name, price] of [
    ['sopa', 1000],
    ['pasta', 2000],
    ['jugo', 333],
  ] as const) {
    products[name] = (
      await call(owner, 'POST', '/catalog/products', { name, price, currency: 'USD' })
    ).json().id;
  }
}, 60_000);

afterAll(async () => {
  await app.close();
  await Promise.all([appPool.end(), authPool.end(), adminPool.end(), inboxPool.end()]);
});

describe('cuenta completa', () => {
  it('se cobra por el flujo existente y se cierra SOLO tras verificar en el servidor', async () => {
    const orderId = await orderWithBill([
      ['sopa', 1],
      ['jugo', 1],
    ]);
    // El mesero pide la cuenta pero no la gestiona.
    expect((await call(waiter, 'POST', `/dining/orders/${orderId}/bill`)).statusCode).toBe(403);
    const bill = await call(cashier, 'POST', `/dining/orders/${orderId}/bill`);
    expect(bill.statusCode).toBe(201);
    expect(bill.json()).toMatchObject({ total: 1333, remainder: 1333, status: 'open' });
    // Reabrir devuelve la MISMA cuenta.
    const again = await call(cashier, 'POST', `/dining/orders/${orderId}/bill`);
    expect(again.json().id).toBe(bill.json().id);

    const full = await call(cashier, 'POST', `/dining/bills/${bill.json().id}/allocations`, {
      kind: 'full',
      expected_version: bill.json().version,
    });
    expect(full.statusCode).toBe(201);
    const part = full.json().allocations[0];
    expect(part).toMatchObject({ amount: 1333, charge: 'none' });

    // Rechazo del banco: la cuenta sigue abierta y se puede reintentar.
    const declined = await pay(part.pay_url, 'tok_decline');
    expect(declined.confirm!.statusCode).toBeGreaterThanOrEqual(200);
    const afterDecline = (await call(cashier, 'GET', `/dining/bills/${bill.json().id}`)).json();
    expect(afterDecline.status).toBe('open');
    expect(afterDecline.allocations[0].charge).toBe('failed');

    const ok = await pay(part.pay_url, 'tok_approve');
    expect(ok.confirm!.statusCode).toBe(200);
    const paid = (await call(cashier, 'GET', `/dining/bills/${bill.json().id}`)).json();
    expect(paid).toMatchObject({ status: 'paid', charged: 1333, remainder: 0 });
    expect(paid.allocations[0].pay_url).toBeNull();
    const order = (await call(waiter, 'GET', `/dining/orders/${orderId}`)).json();
    expect(order.status).toBe('closed');
    // Una venta de cobro único ya cobrada no abre otro checkout.
    const second = await pay(part.pay_url, 'tok_approve');
    expect(second.opened.statusCode).toBe(409);
  });
});

describe('cuenta dividida', () => {
  let billId: string;
  let version: number;
  let pastaLine: string;

  it('por artículos, por monto y en partes iguales: sumas exactas en unidades menores', async () => {
    const orderId = await orderWithBill([
      ['sopa', 1],
      ['pasta', 1],
      ['jugo', 1],
    ]);
    const b = (await call(cashier, 'POST', `/dining/orders/${orderId}/bill`)).json();
    billId = b.id;
    expect(b.total).toBe(3333);
    pastaLine = b.lines.find((l: { name: string }) => l.name === 'pasta').id;

    const items = await call(cashier, 'POST', `/dining/bills/${billId}/allocations`, {
      kind: 'items',
      bill_line_ids: [pastaLine],
      label: 'Ana',
      expected_version: b.version,
    });
    expect(items.statusCode).toBe(201);
    expect(items.json()).toMatchObject({ allocated: 2000, remainder: 1333 });

    // El mismo artículo no entra en dos fracciones vivas.
    const dupItem = await call(cashier, 'POST', `/dining/bills/${billId}/allocations`, {
      kind: 'items',
      bill_line_ids: [pastaLine],
      expected_version: items.json().version,
    });
    expect(dupItem.json().error.code).toBe('bill_allocation_invalid');
    // Más que el remanente: rechazado.
    const over = await call(cashier, 'POST', `/dining/bills/${billId}/allocations`, {
      kind: 'amount',
      amount: 1334,
      expected_version: items.json().version,
    });
    expect(over.statusCode).toBe(409);
    expect(over.json().error.code).toBe('bill_allocation_invalid');
    // Versión vieja: conflicto.
    const stale = await call(cashier, 'POST', `/dining/bills/${billId}/allocations`, {
      kind: 'amount',
      amount: 100,
      expected_version: b.version,
    });
    expect(stale.json().error.code).toBe('version_conflict');

    const eq = await call(cashier, 'POST', `/dining/bills/${billId}/allocations/equal`, {
      parts: 3,
      expected_version: items.json().version,
    });
    expect(eq.statusCode).toBe(201);
    const amounts = eq
      .json()
      .allocations.filter((a: { kind: string }) => a.kind === 'amount')
      .map((a: { amount: number }) => a.amount);
    expect(amounts).toEqual([445, 444, 444]);
    expect(eq.json()).toMatchObject({ allocated: 3333, remainder: 0 });
    version = eq.json().version;
  });

  it('una fracción incierta retiene: no se anula ni se recobra; la cuenta no se cierra', async () => {
    const bill = (await call(cashier, 'GET', `/dining/bills/${billId}`)).json();
    const [ana, p1, p2, p3] = bill.allocations;
    expect((await pay(ana.pay_url, 'tok_approve')).confirm!.statusCode).toBe(200);
    expect((await pay(p1.pay_url, 'tok_approve')).confirm!.statusCode).toBe(200);
    const pending = await pay(p2.pay_url, 'tok_pse');
    expect(pending.confirm!.statusCode).toBeLessThan(500);

    const mid = (await call(cashier, 'GET', `/dining/bills/${billId}`)).json();
    expect(mid.status).toBe('open');
    expect(mid.allocations[2].charge).toBe('in_progress');
    // No se puede abrir otro cobro sobre la fracción retenida…
    expect((await pay(p2.pay_url, 'tok_approve')).opened.statusCode).toBe(409);
    // …ni anularla (el dinero podría estar cobrado).
    const held = await call(cashier, 'POST', `/dining/bills/${billId}/allocations/${p2.id}/void`, {
      reason: 'cliente se fue',
      expected_version: mid.version,
    });
    expect(held.statusCode).toBe(409);
    expect(held.json().error.code).toBe('allocation_payment_held');

    // La parte 3 sin cobro SÍ se anula: su link se deshabilita.
    const voided = await call(
      cashier,
      'POST',
      `/dining/bills/${billId}/allocations/${p3.id}/void`,
      {
        reason: 'se juntó con otra parte',
        expected_version: mid.version,
      }
    );
    expect(voided.statusCode).toBe(200);
    expect(voided.json().remainder).toBe(444);
    const dead = await pay(p3.pay_url, 'tok_approve');
    expect(dead.opened.statusCode).toBe(404);
    version = voided.json().version;

    // Resto por monto, cobrado.
    const rest = await call(cashier, 'POST', `/dining/bills/${billId}/allocations`, {
      kind: 'amount',
      amount: 444,
      label: 'Resto',
      expected_version: version,
    });
    const restPart = rest.json().allocations.find((a: { label: string }) => a.label === 'Resto');
    expect((await pay(restPart.pay_url, 'tok_approve')).confirm!.statusCode).toBe(200);
    const still = (await call(cashier, 'GET', `/dining/bills/${billId}`)).json();
    expect(still.status).toBe('open'); // falta confirmar la incierta
    expect(still.charged).toBe(3333 - 444);

    // El proveedor confirma por webhook firmado → la verificación cierra.
    await settleByWebhook(pending.linkId!, 'payment.succeeded');
    const done = (await call(cashier, 'GET', `/dining/bills/${billId}`)).json();
    expect(done).toMatchObject({ status: 'paid', charged: 3333, anomalies: [] });
  });
});

describe('concurrencia entre cajeros', () => {
  it('dos asignaciones simultáneas sobre la misma versión: una gana, nunca sobreasigna', async () => {
    const orderId = await orderWithBill([['pasta', 2]]);
    const b = (await call(cashier, 'POST', `/dining/orders/${orderId}/bill`)).json();
    const [r1, r2] = await Promise.all([
      call(cashier, 'POST', `/dining/bills/${b.id}/allocations`, {
        kind: 'amount',
        amount: 3000,
        expected_version: b.version,
      }),
      call(cashier2, 'POST', `/dining/bills/${b.id}/allocations`, {
        kind: 'amount',
        amount: 3000,
        expected_version: b.version,
      }),
    ]);
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([201, 409]);
    const sum = await adminPool.query<{ s: string }>(
      `SELECT COALESCE(SUM(amount),0)::text AS s FROM dining_bill_allocations
        WHERE bill_id = $1 AND voided_at IS NULL`,
      [b.id]
    );
    expect(Number(sum.rows[0]!.s)).toBe(3000);
  });

  it('la invariante vive en el MOTOR: una inserción directa que sobreasigna no confirma', async () => {
    const orderId = await orderWithBill([['sopa', 1]]);
    const b = (await call(cashier, 'POST', `/dining/orders/${orderId}/bill`)).json();
    const merchant = await adminPool.query<{ id: string }>(
      `SELECT merchant_id AS id FROM dining_bills WHERE id = $1`,
      [b.id]
    );
    const c = await adminPool.connect();
    try {
      await c.query('BEGIN');
      for (let i = 0; i < 2; i++) {
        const l = await c.query<{ id: string }>(
          `INSERT INTO payment_links (tenant_id, merchant_id, amount, currency, single_charge)
           VALUES ($1, $2, 600, 'USD', true) RETURNING id`,
          [org, merchant.rows[0]!.id]
        );
        await c.query(
          `INSERT INTO dining_bill_allocations (tenant_id, bill_id, kind, amount, currency, payment_link_id)
           VALUES ($1, $2, 'amount', 600, 'USD', $3)`,
          [org, b.id, l.rows[0]!.id]
        );
      }
      await expect(c.query('COMMIT')).rejects.toThrow(/FLUVIA_BILL_OVERALLOCATED/);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  });
});

describe('comensal (token de seguimiento)', () => {
  it('ve SU cuenta y paga una parte desde su teléfono', async () => {
    // Pedido de cliente por QR.
    const area = (
      await call(owner, 'POST', '/venue/areas', { branch_id: branch, name: 'Terraza' })
    ).json().id;
    const table = (
      await call(owner, 'POST', '/venue/tables', {
        branch_id: branch,
        area_id: area,
        label: 'T1',
        capacity: 2,
      })
    ).json();
    const created = await app.inject({
      method: 'POST',
      url: `/v1/public/tables/${table.qr_token}/orders`,
      headers: { 'idempotency-key': `qr-${randomUUID()}` },
      payload: { expected_total: 1000, lines: [{ product_id: products.sopa, quantity: 1 }] },
    });
    expect(created.statusCode).toBe(201);
    const tracking = created.json().tracking_token;
    const none = await app.inject({
      method: 'GET',
      url: `/v1/public/dining/orders/${tracking}/bill`,
    });
    expect(none.statusCode).toBe(404);

    const list = (await call(waiter, 'GET', `/dining/orders?branch_id=${branch}`)).json();
    const o = list.data.find((x: { table_label: string }) => x.table_label === 'T1');
    const acc = await call(waiter, 'POST', `/dining/orders/${o.id}/decision`, {
      expected_version: o.version,
      accept: true,
    });
    const rb = await call(waiter, 'POST', `/dining/orders/${o.id}/request-bill`, {
      expected_version: acc.json().version,
    });
    expect(rb.statusCode).toBe(200);
    const bill = (await call(cashier, 'POST', `/dining/orders/${o.id}/bill`)).json();
    await call(cashier, 'POST', `/dining/bills/${bill.id}/allocations`, {
      kind: 'full',
      expected_version: bill.version,
    });

    const view = await app.inject({
      method: 'GET',
      url: `/v1/public/dining/orders/${tracking}/bill`,
    });
    expect(view.statusCode).toBe(200);
    expect(view.json()).toMatchObject({ total: 1000, status: 'open' });
    expect(JSON.stringify(view.json())).not.toMatch(/payment_intent|tenant|merchant_id/);
    const part = view.json().parts[0];
    expect(part.pay_url).toContain('/l/');
    expect((await pay(part.pay_url, 'tok_approve')).confirm!.statusCode).toBe(200);
    const after = await app.inject({
      method: 'GET',
      url: `/v1/public/dining/orders/${tracking}/bill`,
    });
    expect(after.json()).toMatchObject({ status: 'paid', charged: 1000 });
    expect(after.json().parts[0].pay_url).toBeNull();
  });
});
