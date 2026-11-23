import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@fluvia/config';
import { createPool, type Pool } from '@fluvia/db';
import { AuthService } from '@fluvia/auth';
import { ApiKeyService, IdentityService } from '@fluvia/identity';
import { buildApp } from '../src/app.js';

/**
 * F3-05b — checkout sessions sobre HTTP real: creación idempotente, el
 * client_secret una sola vez, guard de estado del intent (409), scope y
 * aislamiento por tenant (404).
 */

let app: FastifyInstance;
let appPool: Pool;
let authPool: Pool;
let adminPool: Pool;
let apiKeyService: ApiKeyService;

let orgA: string;
let orgB: string;
let merchantA: string;
let keyA: string; // read + payments:write
let keyARead: string; // solo read
let keyB: string; // otro tenant

async function createOrg(name: string): Promise<string> {
  const res = await adminPool.query<{ id: string }>(
    'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id',
    [name, `org-${randomUUID()}`]
  );
  return res.rows[0]!.id;
}

async function createMerchant(orgId: string): Promise<string> {
  const res = await adminPool.query<{ id: string }>(
    'INSERT INTO merchants (tenant_id, name) VALUES ($1, $2) RETURNING id',
    [orgId, `co-shop-${randomUUID().slice(0, 8)}`]
  );
  return res.rows[0]!.id;
}

function auth(key: string) {
  return { authorization: `Bearer ${key}` };
}

async function newIntent(key = keyA, merchant = merchantA): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/payment_intents',
    headers: { ...auth(key), 'idempotency-key': `pi-${randomUUID()}` },
    payload: { merchant_id: merchant, amount: 50_000, currency: 'COP' },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

beforeAll(async () => {
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' });
  appPool = createPool({ connectionString: config.db.app, max: 6 });
  authPool = createPool({ connectionString: config.db.auth, max: 2 });
  adminPool = createPool({ connectionString: config.db.admin, max: 2 });
  apiKeyService = new ApiKeyService(appPool);
  app = buildApp({
    config,
    appPool,
    authService: new AuthService(authPool),
    identityService: new IdentityService(appPool),
    apiKeyService,
  });
  await app.ready();

  orgA = await createOrg('CO Org A');
  orgB = await createOrg('CO Org B');
  merchantA = await createMerchant(orgA);
  keyA = (await apiKeyService.create(orgA, { label: 'co-a', scopes: ['read', 'payments:write'] }))
    .secret;
  keyARead = (await apiKeyService.create(orgA, { label: 'co-a-ro', scopes: ['read'] })).secret;
  keyB = (await apiKeyService.create(orgB, { label: 'co-b', scopes: ['read', 'payments:write'] }))
    .secret;
}, 30_000);

afterAll(async () => {
  await app.close();
  await Promise.all([appPool.end(), authPool.end(), adminPool.end()]);
});

describe('POST /v1/checkout_sessions', () => {
  it('creates a session, returns the client_secret once, and replays exactly', async () => {
    const intentId = await newIntent();
    const key = `cs-${randomUUID()}`;
    const first = await app.inject({
      method: 'POST',
      url: '/v1/checkout_sessions',
      headers: { ...auth(keyA), 'idempotency-key': key },
      payload: { payment_intent_id: intentId },
    });
    expect(first.statusCode).toBe(201);
    const body = first.json();
    expect(body.object).toBe('checkout_session');
    expect(body.status).toBe('open');
    expect(body.client_secret).toMatch(/^cs_/);
    expect(body.url).toContain(`/c/${body.id}`);

    // El GET nunca expone el client_secret.
    const got = await app.inject({
      method: 'GET',
      url: `/v1/checkout_sessions/${body.id}`,
      headers: auth(keyARead),
    });
    expect(got.statusCode).toBe(200);
    expect(got.json()).not.toHaveProperty('client_secret');

    // Replay exacto: misma respuesta (incl. client_secret), una sola sesión.
    const second = await app.inject({
      method: 'POST',
      url: '/v1/checkout_sessions',
      headers: { ...auth(keyA), 'idempotency-key': key },
      payload: { payment_intent_id: intentId },
    });
    expect(second.statusCode).toBe(201);
    expect(second.headers['idempotency-replayed']).toBe('true');
    expect(second.json()).toEqual(body);
    const rows = await adminPool.query(`SELECT 1 FROM checkout_sessions WHERE id = $1`, [body.id]);
    expect(rows.rowCount).toBe(1);
  });

  it('rejects a session over a resolved intent (409 invalid_state_transition)', async () => {
    const intentId = await newIntent();
    await app.inject({
      method: 'POST',
      url: `/v1/payment_intents/${intentId}/cancel`,
      headers: { ...auth(keyA), 'idempotency-key': `cancel-${randomUUID()}` },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/checkout_sessions',
      headers: { ...auth(keyA), 'idempotency-key': `cs-${randomUUID()}` },
      payload: { payment_intent_id: intentId },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('invalid_state_transition');
  });

  it('requires payments:write (403) and the Idempotency-Key (400)', async () => {
    const intentId = await newIntent();
    const noScope = await app.inject({
      method: 'POST',
      url: '/v1/checkout_sessions',
      headers: { ...auth(keyARead), 'idempotency-key': `cs-${randomUUID()}` },
      payload: { payment_intent_id: intentId },
    });
    expect(noScope.statusCode).toBe(403);
    expect(noScope.json().error.code).toBe('insufficient_scope');

    const noKey = await app.inject({
      method: 'POST',
      url: '/v1/checkout_sessions',
      headers: auth(keyA),
      payload: { payment_intent_id: intentId },
    });
    expect(noKey.statusCode).toBe(400);
    expect(noKey.json().error.code).toBe('idempotency_key_required');
  });

  it('another tenant cannot open a session over this intent (404)', async () => {
    const intentId = await newIntent();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/checkout_sessions',
      headers: { ...auth(keyB), 'idempotency-key': `cs-${randomUUID()}` },
      payload: { payment_intent_id: intentId },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
  });
});

describe('GET + list', () => {
  it('list is tenant-scoped; the other tenant sees nothing', async () => {
    const intentId = await newIntent();
    const created = await app.inject({
      method: 'POST',
      url: '/v1/checkout_sessions',
      headers: { ...auth(keyA), 'idempotency-key': `cs-${randomUUID()}` },
      payload: { payment_intent_id: intentId },
    });
    const id = created.json().id as string;

    const mine = await app.inject({
      method: 'GET',
      url: '/v1/checkout_sessions?limit=100',
      headers: auth(keyARead),
    });
    expect((mine.json().data as Array<{ id: string }>).some((s) => s.id === id)).toBe(true);

    const foreignGet = await app.inject({
      method: 'GET',
      url: `/v1/checkout_sessions/${id}`,
      headers: auth(keyB),
    });
    expect(foreignGet.statusCode).toBe(404);
  });
});

describe('GET /v1/checkout_sessions/:id/status (plano alojado, sin API key)', () => {
  async function createSession(): Promise<{ id: string; clientSecret: string }> {
    const intentId = await newIntent();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/checkout_sessions',
      headers: { ...auth(keyA), 'idempotency-key': `cs-${randomUUID()}` },
      payload: { payment_intent_id: intentId },
    });
    return { id: res.json().id as string, clientSecret: res.json().client_secret as string };
  }

  it('returns the redacted hosted view with the client_secret and NO API key', async () => {
    const { id, clientSecret } = await createSession();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/checkout_sessions/${id}/status`,
      headers: { 'x-checkout-client-secret': clientSecret },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.object).toBe('checkout_session.hosted');
    expect(body.status).toBe('open');
    expect(body.payment_intent.amount).toBe(50_000);
    expect(body.payment_intent.currency).toBe('COP');
    // Vista redactada: sin secreto ni internos del comercio.
    expect(body).not.toHaveProperty('client_secret');
    expect(JSON.stringify(body)).not.toContain('tenant');
  });

  it('completes and reflects succeeded after the intent is confirmed (tok_approve)', async () => {
    const intentId = await newIntent();
    const created = await app.inject({
      method: 'POST',
      url: '/v1/checkout_sessions',
      headers: { ...auth(keyA), 'idempotency-key': `cs-${randomUUID()}` },
      payload: { payment_intent_id: intentId },
    });
    const { id, client_secret } = created.json();

    // El pago se confirma por la vía existente (F3-03); la sesión se sincroniza.
    const confirm = await app.inject({
      method: 'POST',
      url: `/v1/payment_intents/${intentId}/confirm`,
      headers: { ...auth(keyA), 'idempotency-key': `cf-${randomUUID()}` },
      payload: { payment_method_token: 'tok_approve' },
    });
    expect(confirm.statusCode).toBe(200);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/checkout_sessions/${id}/status`,
      headers: { 'x-checkout-client-secret': client_secret },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('completed');
    expect(res.json().payment_intent.status).toBe('succeeded');
  });

  it('a wrong or missing client_secret is 404 (anti-enumeration)', async () => {
    const { id } = await createSession();
    const wrong = await app.inject({
      method: 'GET',
      url: `/v1/checkout_sessions/${id}/status`,
      headers: { 'x-checkout-client-secret': 'cs_wrong' },
    });
    expect(wrong.statusCode).toBe(404);
    expect(wrong.json().error.code).toBe('not_found');

    const missing = await app.inject({
      method: 'GET',
      url: `/v1/checkout_sessions/${id}/status`,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('not_found');
  });

  it('POST /confirm with the client_secret pays and completes the session (tok_approve)', async () => {
    const { id, clientSecret } = await createSession();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/checkout_sessions/${id}/confirm`,
      headers: { 'x-checkout-client-secret': clientSecret },
      payload: { payment_method_token: 'tok_approve' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('completed');
    expect(res.json().payment_intent.status).toBe('succeeded');
  });

  it('POST /confirm with tok_decline reflects a failed intent; session stays open', async () => {
    const { id, clientSecret } = await createSession();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/checkout_sessions/${id}/confirm`,
      headers: { 'x-checkout-client-secret': clientSecret },
      payload: { payment_method_token: 'tok_decline' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('open');
    expect(res.json().payment_intent.status).toBe('failed');
  });

  it('POST /confirm rejects a wrong secret (404) and a missing token (400)', async () => {
    const { id, clientSecret } = await createSession();
    const wrong = await app.inject({
      method: 'POST',
      url: `/v1/checkout_sessions/${id}/confirm`,
      headers: { 'x-checkout-client-secret': 'cs_wrong' },
      payload: { payment_method_token: 'tok_approve' },
    });
    expect(wrong.statusCode).toBe(404);

    const badBody = await app.inject({
      method: 'POST',
      url: `/v1/checkout_sessions/${id}/confirm`,
      headers: { 'x-checkout-client-secret': clientSecret },
      payload: {},
    });
    expect(badBody.statusCode).toBe(400);
    expect(badBody.json().error.code).toBe('validation_error');
  });
});

describe('success_url / cancel_url: solo http(s) (anti-XSS por esquema)', () => {
  function create(payload: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: '/v1/checkout_sessions',
      headers: { ...auth(keyA), 'idempotency-key': `cs-${randomUUID()}` },
      payload,
    });
  }

  it('accepts https/http URLs and echoes them in the session and the hosted view', async () => {
    const res = await create({
      payment_intent_id: await newIntent(),
      success_url: 'https://shop.example.com/thanks',
      cancel_url: 'http://localhost:3000/cart',
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.success_url).toBe('https://shop.example.com/thanks');
    expect(body.cancel_url).toBe('http://localhost:3000/cart');

    const hosted = await app.inject({
      method: 'GET',
      url: `/v1/checkout_sessions/${body.id}/status`,
      headers: { 'x-checkout-client-secret': body.client_secret },
    });
    expect(hosted.statusCode).toBe(200);
    expect(hosted.json().success_url).toBe('https://shop.example.com/thanks');
    expect(hosted.json().cancel_url).toBe('http://localhost:3000/cart');
  });

  it.each([
    'javascript:alert(1)',
    'JAVASCRIPT:alert(document.cookie)',
    'javascript://shop.example.com/%0Aalert(1)',
    'java\tscript:alert(1)',
    ' javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'ftp://example.com/x',
    'https://shop.example.com@evil.example.com/',
    '/relative/path',
    // Protocol-relative y variantes que WHATWG "repara" hacia otro host
    '//evil.example.com/x',
    '\\\\evil.example.com/x',
    'https:\\\\evil.example.com/',
    'http:/evil.example.com',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'https://shop.example.com\u00a0/ok',
  ])('rejects %j as success_url and as cancel_url (400, nothing created)', async (url) => {
    for (const field of ['success_url', 'cancel_url']) {
      const intentId = await newIntent();
      const res = await create({ payment_intent_id: intentId, [field]: url });
      expect(res.statusCode).toBe(400);
      const err = res.json().error;
      expect(err.code).toBe('validation_error');
      expect(err.details).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: field })])
      );
      const rows = await adminPool.query(
        `SELECT 1 FROM checkout_sessions WHERE payment_intent_id = $1`,
        [intentId]
      );
      expect(rows.rowCount).toBe(0);
    }
  });

  it('the hosted view never returns a dangerous URL stored before the rule', async () => {
    const res = await create({ payment_intent_id: await newIntent() });
    const { id, client_secret } = res.json();
    await adminPool.query(
      `UPDATE checkout_sessions SET success_url = 'javascript:alert(1)',
                                    cancel_url = 'data:text/html,x' WHERE id = $1`,
      [id]
    );
    const hosted = await app.inject({
      method: 'GET',
      url: `/v1/checkout_sessions/${id}/status`,
      headers: { 'x-checkout-client-secret': client_secret },
    });
    expect(hosted.statusCode).toBe(200);
    expect(hosted.json().success_url).toBeNull();
    expect(hosted.json().cancel_url).toBeNull();

    const got = await app.inject({
      method: 'GET',
      url: `/v1/checkout_sessions/${id}`,
      headers: auth(keyARead),
    });
    expect(got.json().success_url).toBeNull();
    expect(got.json().cancel_url).toBeNull();
  });
});
