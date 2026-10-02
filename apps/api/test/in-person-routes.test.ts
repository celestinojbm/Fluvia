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
 * Cobro presencial del INDEPENDIENTE («Cobrar» en el teléfono) contra
 * PostgreSQL real y el flujo de pago existente. No hay tarjeta física ni
 * proveedor real: el terminal es el SIMULADOR de sandbox, marcado como tal, y
 * el resultado lo decide el proveedor sandbox del servidor. Se prueban la
 * habilitación explícita, el veredicto de dispositivo, la idempotencia del
 * teléfono, toques duplicados, pérdida de conexión, incierto resuelto por
 * webhook firmado (también duplicado) y que nunca haya un segundo cargo.
 */

let app: FastifyInstance;
let appPool: Pool;
let authPool: Pool;
let adminPool: Pool;
let inboxPool: Pool;
let processor: InboxProcessor;
let secret: string;
let org: string;
type User = { userId: string; headers: Record<string, string> };
let owner: User;
let staff: User;

async function sessionUser(role: string): Promise<User> {
  const email = `ip-${randomUUID().slice(0, 12)}@example.com`;
  const reg = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email, password: 'in person pass 77' },
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
    payload: { email, password: 'in person pass 77' },
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

async function newCharge(amount: number, key = `cobro-${randomUUID()}`) {
  const r = await call(owner, 'POST', '/in-person/payments', {
    method: 'simulator',
    client_key: key,
    source: { kind: 'amount', amount, currency: 'USD', concept: 'Carrera aeropuerto' },
  });
  expect(r.statusCode).toBe(201);
  return r.json();
}

async function toWaiting(p: { id: string; version: number }) {
  const ready = await call(owner, 'POST', `/in-person/payments/${p.id}/state`, {
    to: 'ready',
    expected_version: p.version,
  });
  const waiting = await call(owner, 'POST', `/in-person/payments/${p.id}/state`, {
    to: 'waiting_card',
    expected_version: ready.json().version,
  });
  expect(waiting.json().state).toBe('waiting_card');
  return waiting.json();
}

const charges = async (linkId: string) =>
  Number(
    (
      await adminPool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM payment_intents WHERE payment_link_id = $1
           AND status IN ('succeeded', 'partially_refunded', 'refunded')`,
        [linkId]
      )
    ).rows[0]!.n
  );

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
  const intents = new PaymentIntentService(appPool);
  const posting = new PostingService(new LedgerService(appPool), appPool);
  const provider = new MockPaymentProvider();
  processor = new InboxProcessor(inboxPool, {});
  processor.register(
    MOCK_PROVIDER_NAME,
    createMockInboxRegistration(
      new PaymentConfirmationService(appPool, intents, posting, provider, ZERO_FEE_SCHEDULE),
      new PayoutService(appPool, posting, provider),
      new DisputeService(appPool, posting)
    )
  );
  org = (
    await adminPool.query<{ id: string }>(
      'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id',
      ['Taxi Independiente', `org-${randomUUID()}`]
    )
  ).rows[0]!.id;
  await adminPool.query(
    `INSERT INTO merchants (tenant_id, name, default_currency) VALUES ($1, 'Carlos Taxi', 'USD')`,
    [org]
  );
  owner = await sessionUser('owner');
  staff = await sessionUser('staff');
}, 60_000);

afterAll(async () => {
  await app.close();
  await Promise.all([appPool.end(), authPool.end(), adminPool.end(), inboxPool.end()]);
});

describe('perfil independiente y habilitación explícita', () => {
  it('sin tienda: perfil servicios; cobrar exige habilitación (pendiente por defecto)', async () => {
    const p = await call(owner, 'PUT', '/business-profile', {
      business_type: 'services',
      solo: true,
      expected_version: 0,
    });
    expect(p.json()).toMatchObject({ solo: true, vocabulary: { newSale: 'Cobrar' } });
    expect(p.json().modules).toEqual(expect.arrayContaining(['in_person', 'payment_links']));
    expect(p.json().modules).not.toContain('tables');

    const blocked = await call(owner, 'POST', '/in-person/payments', {
      method: 'simulator',
      client_key: `k-${randomUUID()}`,
      source: { kind: 'amount', amount: 1000, currency: 'USD' },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('collection_not_enabled');

    for (const r of ['identity', 'payout_account', 'terms', 'device']) {
      await call(owner, 'POST', `/collection-enablement/requirements/${r}/complete`);
    }
    const en = await call(owner, 'POST', '/collection-enablement/sandbox-decision', {
      status: 'enabled',
    });
    expect(en.json()).toMatchObject({ status: 'enabled', provider: 'sandbox_simulator' });
  });

  it('el servidor decide la compatibilidad; un navegador no es un terminal certificado', async () => {
    const web = await call(owner, 'POST', '/in-person/devices', { platform: 'web', nfc: true });
    expect(web.json()).toMatchObject({
      capability: 'incompatible',
      reasons: expect.arrayContaining(['web_is_not_a_certified_terminal']),
    });
    const old = await call(owner, 'POST', '/in-person/devices', {
      platform: 'android',
      os_version: '11',
      nfc: true,
    });
    expect(old.json()).toMatchObject({
      capability: 'incompatible',
      reasons: ['android_13_required'],
    });
    const ok = await call(owner, 'POST', '/in-person/devices', {
      platform: 'android',
      os_version: '14',
      nfc: true,
      model: 'Pixel 8',
    });
    expect(ok.json().capability).toBe('compatible');
    // Con el proveedor de sandbox no hay SDK real que lea tarjetas: Tap to Pay
    // real se rechaza en lugar de fingir una lectura.
    const tap = await call(owner, 'POST', '/in-person/payments', {
      method: 'tap_to_pay',
      device_id: ok.json().id,
      client_key: `k-${randomUUID()}`,
      source: { kind: 'amount', amount: 1000, currency: 'USD' },
    });
    expect(tap.statusCode).toBe(409);
    expect(tap.json().error.code).toBe('invalid_state_transition');
  });
});

describe('Cobrar → Acercar tarjeta (simulador) → resultado verificado → recibo', () => {
  it('aprobado por el proveedor sandbox; recibo marcado como simulado; un solo cargo', async () => {
    const key = `cobro-${randomUUID()}`;
    const p = await newCharge(2500, key);
    expect(p).toMatchObject({ state: 'preparing', simulated: true, amount: 2500 });
    // Reintento tras perder la respuesta: MISMO cobro.
    const again = await call(owner, 'POST', '/in-person/payments', {
      method: 'simulator',
      client_key: key,
      source: { kind: 'amount', amount: 2500, currency: 'USD', concept: 'Carrera aeropuerto' },
    });
    expect(again.json().id).toBe(p.id);
    const other = await call(owner, 'POST', '/in-person/payments', {
      method: 'simulator',
      client_key: key,
      source: { kind: 'amount', amount: 9999, currency: 'USD' },
    });
    expect(other.statusCode).toBe(422);

    // El cliente no puede declararse aprobado.
    const fake = await call(owner, 'POST', `/in-person/payments/${p.id}/state`, {
      to: 'approved',
      expected_version: p.version,
    });
    expect(fake.statusCode).toBe(400);

    const w = await toWaiting(p);
    const [a, b] = await Promise.all([
      call(owner, 'POST', `/in-person/payments/${w.id}/simulate`, { outcome: 'approve' }),
      call(owner, 'POST', `/in-person/payments/${w.id}/simulate`, { outcome: 'approve' }),
    ]);
    expect([a.statusCode, b.statusCode].every((s) => s === 200 || s === 409)).toBe(true);
    const done = (await call(owner, 'GET', `/in-person/payments/${w.id}`)).json();
    expect(done).toMatchObject({ state: 'approved', simulated: true });
    expect(done.receipt).toMatchObject({ amount: 2500, currency: 'USD', simulated: true });
    expect(await charges(done.payment_link_id)).toBe(1);
    // Toque tardío: no reprocesa.
    const late = await call(owner, 'POST', `/in-person/payments/${w.id}/simulate`, {
      outcome: 'approve',
    });
    expect(late.json().state).toBe('approved');
    expect(await charges(done.payment_link_id)).toBe(1);
  });

  it('rechazado: terminal; otro cobro nuevo es otra venta', async () => {
    const w = await toWaiting(await newCharge(700));
    const r = await call(owner, 'POST', `/in-person/payments/${w.id}/simulate`, {
      outcome: 'decline',
    });
    expect(r.json()).toMatchObject({ state: 'declined', receipt: null });
    expect(r.json().failure_code).toBeTruthy();
    expect(await charges(r.json().payment_link_id)).toBe(0);
  });

  it('incierto: no se recobra; el webhook firmado (también duplicado) lo resuelve una vez', async () => {
    const w = await toWaiting(await newCharge(1200));
    const r = await call(owner, 'POST', `/in-person/payments/${w.id}/simulate`, {
      outcome: 'pending',
    });
    expect(r.json().state).toBe('uncertain');
    // Mientras está incierto, la venta no admite otro checkout.
    const reopen = await app.inject({
      method: 'POST',
      url: `/v1/payment_links/${r.json().payment_link_id}/sessions`,
    });
    expect(reopen.statusCode).toBe(409);

    const att = await adminPool.query<{ id: string; provider_ref: string }>(
      `SELECT id, provider_ref FROM payment_attempts WHERE intent_id = $1`,
      [r.json().payment_intent_id]
    );
    const body = JSON.stringify({
      event_id: `evt-${randomUUID()}`,
      type: 'payment.succeeded',
      tenant_id: org,
      attempt_id: att.rows[0]!.id,
      provider_ref: att.rows[0]!.provider_ref,
    });
    for (let i = 0; i < 2; i++) {
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
      expect(res.json().duplicate).toBe(i === 1);
    }
    await processor.runOnce();
    const after = (await call(owner, 'GET', `/in-person/payments/${w.id}`)).json();
    expect(after.state).toBe('approved');
    expect(await charges(after.payment_link_id)).toBe(1);
  });

  it('tiempo agotado del proveedor: incierto, nunca aprobado por defecto', async () => {
    const w = await toWaiting(await newCharge(300));
    const r = await call(owner, 'POST', `/in-person/payments/${w.id}/simulate`, {
      outcome: 'timeout',
    });
    expect(r.json().state).toBe('uncertain');
    expect(r.json().receipt).toBeNull();
  });

  it('cancelar antes de acercar la tarjeta: sin cargo; un toque posterior no cobra', async () => {
    const p = await newCharge(450);
    const c = await call(owner, 'POST', `/in-person/payments/${p.id}/state`, {
      to: 'canceled',
      expected_version: p.version,
    });
    expect(c.json().state).toBe('canceled');
    const t = await call(owner, 'POST', `/in-person/payments/${p.id}/simulate`, {
      outcome: 'approve',
    });
    expect(t.json().state).toBe('canceled');
    expect(await charges(p.payment_link_id)).toBe(0);
  });
});

describe('permisos', () => {
  it('personal sin permiso de cobro no crea cobros por importe; nadie ve cobros ajenos', async () => {
    const r = await call(staff, 'POST', '/in-person/payments', {
      method: 'simulator',
      client_key: `k-${randomUUID()}`,
      source: { kind: 'amount', amount: 100, currency: 'USD' },
    });
    expect(r.statusCode).toBe(403);
    const mine = (await call(owner, 'GET', '/in-person/payments')).json().data[0];
    expect((await call(staff, 'GET', `/in-person/payments/${mine.id}`)).statusCode).toBe(404);
  });
});
