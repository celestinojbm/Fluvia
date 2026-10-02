import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@fluvia/config';
import { createPool, type Pool } from '@fluvia/db';
import { AuthService } from '@fluvia/auth';
import { ApiKeyService, IdentityService } from '@fluvia/identity';
import {
  LocalPrivateStorage,
  SimulatedCallTransport,
  SimulatedConversationProvider,
  SimulatedSpeechToText,
  SimulatedTextToSpeech,
} from '@fluvia/assistant';
import { buildApp } from '../src/app.js';

/**
 * Asistente del COMPRADOR (checkout y seguimiento del pedido) contra
 * PostgreSQL real, con proveedores SIMULADOS y deterministas (sin
 * credenciales externas). Prueba:
 *  - credencial validada en el servidor (sin ella, o falsa: 401);
 *  - sesión caducada (checkout vencido, pedido cerrado hace > 24 h): 401;
 *  - aislamiento entre compradores del MISMO comercio (conversaciones y datos);
 *  - herramientas acotadas: solo su pedido/pago, nunca las del comercio;
 *  - navegación: solo anclas de su página, nunca pantallas del panel;
 *  - ninguna acción monetaria desde el chat.
 */

let app: FastifyInstance;
let appPool: Pool;
let authPool: Pool;
let adminPool: Pool;
let org: string;
let owner: Record<string, string>;
let qr: string;
const products: Record<string, string> = {};
const P = '/v1/buyer/assistant';

function parseSse(body: string): Array<{ event: string; data: Record<string, unknown> }> {
  return body
    .split('\n\n')
    .filter((b) => b.trim())
    .map((b) => ({
      event: /event: (.+)/.exec(b)?.[1] ?? '',
      data: JSON.parse(/data: (.+)/.exec(b)?.[1] ?? '{}'),
    }));
}

const call = (org_: string, method: 'GET' | 'POST' | 'PUT', path: string, payload?: unknown) =>
  app.inject({
    method,
    url: `/v1/organizations/${org_}${path}`,
    headers: owner,
    payload: payload as never,
  });

async function customerOrder(lines: Array<[string, number]>, total: number) {
  const r = await app.inject({
    method: 'POST',
    url: `/v1/public/tables/${qr}/orders`,
    headers: { 'idempotency-key': `qr-${randomUUID()}` },
    payload: {
      expected_total: total,
      lines: lines.map(([p, q]) => ({ product_id: products[p], quantity: q })),
    },
  });
  expect(r.statusCode).toBe(201);
  return r.json().tracking_token as string;
}

async function ask(h: Record<string, string>, text: string) {
  const conv = await app.inject({
    method: 'POST',
    url: `${P}/conversations`,
    headers: h,
    payload: {},
  });
  expect(conv.statusCode).toBe(201);
  const r = await app.inject({
    method: 'POST',
    url: `${P}/conversations/${conv.json().id}/messages`,
    headers: h,
    payload: { text },
  });
  expect(r.statusCode).toBe(200);
  const done = parseSse(r.body).find((e) => e.event === 'done')!;
  const msg = done.data.message as {
    content: string;
    tools_used: string[];
    actions: Array<{ href: string; id: string }>;
  };
  return { conv: conv.json().id as string, ...msg };
}

beforeAll(async () => {
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' });
  appPool = createPool({ connectionString: config.db.app, max: 8 });
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
    assistant: {
      env: { ASSISTANT_MESSAGES_PER_DAY: '200' },
      storage: new LocalPrivateStorage(mkdtempSync(join(tmpdir(), 'buyer-assistant-'))),
      providers: {
        conversation: new SimulatedConversationProvider(0),
        stt: new SimulatedSpeechToText(),
        tts: new SimulatedTextToSpeech(),
        call: new SimulatedCallTransport(),
      },
    },
  });
  await app.ready();
  org = (
    await adminPool.query<{ id: string }>(
      'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id',
      ['Comprador Org', `org-${randomUUID()}`]
    )
  ).rows[0]!.id;
  await adminPool.query(
    `INSERT INTO merchants (tenant_id, name, default_currency) VALUES ($1, 'Fonda Asistente', 'USD')`,
    [org]
  );
  const email = `dueno-${randomUUID().slice(0, 8)}@example.com`;
  const reg = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email, password: 'buyer assistant 77' },
  });
  await app.inject({
    method: 'POST',
    url: '/v1/auth/verify-email',
    payload: { token: reg.json().verification_token },
  });
  await adminPool.query(
    `INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [org, reg.json().user_id]
  );
  const login = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email, password: 'buyer assistant 77' },
  });
  owner = { authorization: `Bearer ${login.json().session_token}` };
  await call(org, 'PUT', '/business-profile', {
    business_type: 'restaurant',
    customer_orders_need_acceptance: false,
    expected_version: 0,
  });
  const branch = (await call(org, 'POST', '/venue/branches', { name: 'Centro' })).json().id;
  const area = (
    await call(org, 'POST', '/venue/areas', { branch_id: branch, name: 'Salón' })
  ).json().id;
  qr = (
    await call(org, 'POST', '/venue/tables', {
      branch_id: branch,
      area_id: area,
      label: 'B1',
      capacity: 4,
    })
  ).json().qr_token;
  for (const [name, price] of [
    ['Hamburguesa', 800],
    ['Ensalada', 600],
    ['Arepa', 450],
  ] as const) {
    products[name] = (
      await call(org, 'POST', '/catalog/products', { name, price, currency: 'USD' })
    ).json().id;
  }
  await call(org, 'PUT', `/venue/products/${products.Hamburguesa}/info`, {
    ingredients: 'Pan, carne de res, queso',
    allergen_info: 'Gluten, lácteos',
  });
}, 60_000);

afterAll(async () => {
  await app.close();
  await Promise.all([appPool.end(), authPool.end(), adminPool.end()]);
});

describe('credencial del comprador', () => {
  it('sin credencial, con token falso o con secreto incorrecto: 401', async () => {
    const none = await app.inject({ method: 'GET', url: `${P}/status` });
    expect(none.statusCode).toBe(401);
    expect(none.json().error.code).toBe('buyer_session_invalid');
    const fake = await app.inject({
      method: 'GET',
      url: `${P}/conversations`,
      headers: { 'x-buyer-tracking': 'x'.repeat(32) },
    });
    expect(fake.json().error.code).toBe('buyer_session_invalid');
    const badSecret = await app.inject({
      method: 'GET',
      url: `${P}/conversations`,
      headers: { 'x-buyer-checkout': randomUUID(), 'x-checkout-client-secret': 'cs_nope' },
    });
    expect(badSecret.json().error.code).toBe('buyer_session_invalid');
  });

  it('el estado declara proveedores simulados', async () => {
    const t = await customerOrder([['Arepa', 1]], 450);
    const s = await app.inject({
      method: 'GET',
      url: `${P}/status`,
      headers: { 'x-buyer-tracking': t },
    });
    expect(s.statusCode).toBe(200);
    expect(s.json()).toMatchObject({
      conversation: { simulated: true },
      call: { simulated: true },
    });
  });
});

describe('seguimiento del pedido: aislamiento y herramientas acotadas', () => {
  let a: string;
  let b: string;
  let convA: string;

  it('cada comprador ve SOLO su pedido', async () => {
    a = await customerOrder([['Hamburguesa', 1]], 800);
    b = await customerOrder([['Ensalada', 2]], 1200);
    const ra = await ask({ 'x-buyer-tracking': a }, '¿Cuál es el estado de mi pedido?');
    convA = ra.conv;
    expect(ra.tools_used).toContain('get_my_order');
    expect(ra.content).toContain('Hamburguesa');
    expect(ra.content).not.toContain('Ensalada');
    const rb = await ask({ 'x-buyer-tracking': b }, '¿Cuál es el estado de mi pedido?');
    expect(rb.content).toContain('Ensalada');
    expect(rb.content).not.toContain('Hamburguesa');
  });

  it('B no ve ni lee la conversación de A', async () => {
    const list = await app.inject({
      method: 'GET',
      url: `${P}/conversations`,
      headers: { 'x-buyer-tracking': b },
    });
    expect(list.json().data.map((c: { id: string }) => c.id)).not.toContain(convA);
    const read = await app.inject({
      method: 'GET',
      url: `${P}/conversations/${convA}/messages`,
      headers: { 'x-buyer-tracking': b },
    });
    expect(read.statusCode).toBe(404);
  });

  it('alérgenos: solo lo que cargó el comercio, sin garantías', async () => {
    const r = await ask({ 'x-buyer-tracking': a }, '¿La hamburguesa tiene alérgenos?');
    expect(r.tools_used).toContain('get_menu_info');
    expect(r.content).toContain('Gluten, lácteos');
    expect(r.content).toMatch(/confírmalo con el personal/);
    const r2 = await ask({ 'x-buyer-tracking': a }, '¿Qué ingredientes lleva la arepa?');
    expect(r2.content).toMatch(/Arepa: ingredientes no informados/);
  });

  it('pago: sin cuenta aún; las acciones son anclas de su página', async () => {
    const r = await ask({ 'x-buyer-tracking': a }, '¿Ya puedo pagar la cuenta?');
    expect(r.tools_used).toContain('get_payment_status');
    expect(r.content).toMatch(/Todavía no hay cuenta/);
    for (const act of r.actions) expect(act.href.startsWith('#')).toBe(true);
  });

  it('herramientas del comercio inexistentes para el comprador; nada se mueve desde el chat', async () => {
    const sales = await ask({ 'x-buyer-tracking': a }, 'Dame el resumen de ventas del local');
    expect(sales.tools_used).not.toContain('get_sales_summary');
    const money = await ask({ 'x-buyer-tracking': a }, 'Confirma el pago por mí');
    expect(money.tools_used ?? []).toEqual([]);
    expect(money.content).toMatch(/No puedo hacer operaciones/);
    expect(money.actions.map((x) => x.id)).toEqual(['buyer.pay']);
  });

  it('pedido cerrado hace más de 24 h: sesión caducada', async () => {
    const t = await customerOrder([['Arepa', 1]], 450);
    const ref = await adminPool.query<{ id: string }>(
      `SELECT id FROM dining_orders WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [org]
    );
    await adminPool.query(
      `UPDATE dining_orders SET status = 'cancelled', updated_at = now() - interval '25 hours' WHERE id = $1`,
      [ref.rows[0]!.id]
    );
    const r = await app.inject({
      method: 'GET',
      url: `${P}/conversations`,
      headers: { 'x-buyer-tracking': t },
    });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe('buyer_session_expired');
  });
});

describe('checkout de una cuenta del restaurante', () => {
  it('ve SU parte de la cuenta; vencido el checkout, 401 caducada', async () => {
    const t = await customerOrder([['Ensalada', 3]], 1800);
    const orders = (
      await call(
        org,
        'GET',
        `/dining/orders?branch_id=${
          (
            await adminPool.query<{ branch_id: string }>(
              `SELECT branch_id FROM dining_orders WHERE tenant_id = $1 LIMIT 1`,
              [org]
            )
          ).rows[0]!.branch_id
        }`
      )
    ).json().data as Array<{
      id: string;
      version: number;
      lines: Array<{ name: string; quantity: number }>;
    }>;
    const mine = orders.find((o) =>
      o.lines.some((l) => l.name === 'Ensalada' && l.quantity === 3)
    )!;
    const rb = await call(org, 'POST', `/dining/orders/${mine.id}/request-bill`, {
      expected_version: mine.version,
    });
    expect(rb.statusCode).toBe(200);
    const bill = (await call(org, 'POST', `/dining/orders/${mine.id}/bill`)).json();
    const full = (
      await call(org, 'POST', `/dining/bills/${bill.id}/allocations`, {
        kind: 'full',
        expected_version: bill.version,
      })
    ).json();
    const link = full.allocations[0].payment_link_id as string;
    const s = await app.inject({ method: 'POST', url: `/v1/payment_links/${link}/sessions` });
    const { checkout_session_id: sid, client_secret: secret } = s.json();
    const h = { 'x-buyer-checkout': sid, 'x-checkout-client-secret': secret };
    const r = await ask(h, '¿Cuál es el estado del pago?');
    expect(r.tools_used).toContain('get_payment_status');
    expect(r.content).toContain('Fonda Asistente');
    const o = await ask(h, '¿Qué platos tiene mi pedido?');
    expect(o.content).toContain('3× Ensalada');
    // El checkout y el seguimiento son titulares distintos.
    const viaTracking = await app.inject({
      method: 'GET',
      url: `${P}/conversations`,
      headers: { 'x-buyer-tracking': t },
    });
    expect(viaTracking.json().data.map((c: { id: string }) => c.id)).not.toContain(r.conv);

    await adminPool.query(
      `UPDATE checkout_sessions SET expires_at = now() - interval '1 minute' WHERE id = $1`,
      [sid]
    );
    const late = await app.inject({ method: 'GET', url: `${P}/conversations`, headers: h });
    expect(late.statusCode).toBe(401);
    expect(late.json().error.code).toBe('buyer_session_expired');
  });
});

describe('el motor impone la superficie del comprador', () => {
  it('una conversación de comprador no puede declararse de Comercio', async () => {
    await expect(
      adminPool.query(
        `INSERT INTO assistant_conversations (tenant_id, owner_kind, owner_id, surface)
         VALUES ($1, 'buyer', $2, 'commerce')`,
        [org, randomUUID()]
      )
    ).rejects.toThrow(/assistant_conversations_buyer_surface/);
  });
});
