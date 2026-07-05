import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@fluvia/config';
import { createPool, type Pool } from '@fluvia/db';
import { AuthService } from '@fluvia/auth';
import { ApiKeyService, IdentityService } from '@fluvia/identity';
import { buildApp } from '../src/app.js';

/**
 * F3-06 — payment links sobre HTTP real: gestión idempotente (API key) +
 * apertura PÚBLICA (sin API key) que genera una sesión de checkout pagable.
 */

let app: FastifyInstance;
let appPool: Pool;
let authPool: Pool;
let adminPool: Pool;
let apiKeyService: ApiKeyService;

let orgA: string;
let orgB: string;
let merchantA: string;
let keyA: string;
let keyARead: string;
let keyB: string;

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
    [orgId, `pl-shop-${randomUUID().slice(0, 8)}`]
  );
  return res.rows[0]!.id;
}
function auth(key: string) {
  return { authorization: `Bearer ${key}` };
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

  orgA = await createOrg('PL Org A');
  orgB = await createOrg('PL Org B');
  merchantA = await createMerchant(orgA);
  keyA = (await apiKeyService.create(orgA, { label: 'pl-a', scopes: ['read', 'payments:write'] }))
    .secret;
  keyARead = (await apiKeyService.create(orgA, { label: 'pl-a-ro', scopes: ['read'] })).secret;
  keyB = (await apiKeyService.create(orgB, { label: 'pl-b', scopes: ['read', 'payments:write'] }))
    .secret;
}, 30_000);

afterAll(async () => {
  await app.close();
  await Promise.all([appPool.end(), authPool.end(), adminPool.end()]);
});

async function createLink(amount = 30_000): Promise<{ id: string; url: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/payment_links',
    headers: { ...auth(keyA), 'idempotency-key': `pl-${randomUUID()}` },
    payload: { merchant_id: merchantA, amount, currency: 'COP', description: 'Suscripción' },
  });
  expect(res.statusCode).toBe(201);
  return { id: res.json().id as string, url: res.json().url as string };
}

describe('gestión (API key)', () => {
  it('creates idempotently and replays; the url points at /l/{id}', async () => {
    const key = `pl-${randomUUID()}`;
    const body = { merchant_id: merchantA, amount: 12_000, currency: 'COP' };
    const first = await app.inject({
      method: 'POST',
      url: '/v1/payment_links',
      headers: { ...auth(keyA), 'idempotency-key': key },
      payload: body,
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().object).toBe('payment_link');
    expect(first.json().url).toContain(`/l/${first.json().id}`);

    const second = await app.inject({
      method: 'POST',
      url: '/v1/payment_links',
      headers: { ...auth(keyA), 'idempotency-key': key },
      payload: body,
    });
    expect(second.headers['idempotency-replayed']).toBe('true');
    expect(second.json()).toEqual(first.json());
  });

  it('rejects an unknown merchant (400) and requires payments:write (403)', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/payment_links',
      headers: { ...auth(keyA), 'idempotency-key': `pl-${randomUUID()}` },
      payload: { merchant_id: randomUUID(), amount: 1000, currency: 'COP' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('validation_error');

    const noScope = await app.inject({
      method: 'POST',
      url: '/v1/payment_links',
      headers: { ...auth(keyARead), 'idempotency-key': `pl-${randomUUID()}` },
      payload: { merchant_id: merchantA, amount: 1000, currency: 'COP' },
    });
    expect(noScope.statusCode).toBe(403);
    expect(noScope.json().error.code).toBe('insufficient_scope');
  });

  it('get/list are tenant-scoped; the other tenant gets 404', async () => {
    const { id } = await createLink();
    const foreign = await app.inject({
      method: 'GET',
      url: `/v1/payment_links/${id}`,
      headers: auth(keyB),
    });
    expect(foreign.statusCode).toBe(404);
    const mine = await app.inject({
      method: 'GET',
      url: '/v1/payment_links?limit=100',
      headers: auth(keyARead),
    });
    expect((mine.json().data as Array<{ id: string }>).some((l) => l.id === id)).toBe(true);
  });
});

describe('apertura pública (sin API key)', () => {
  it('POST :id/sessions generates a payable checkout session that completes', async () => {
    const { id } = await createLink(45_000);
    const opened = await app.inject({ method: 'POST', url: `/v1/payment_links/${id}/sessions` });
    expect(opened.statusCode).toBe(200);
    const { checkout_session_id, client_secret } = opened.json();
    expect(checkout_session_id).toBeTruthy();
    expect(client_secret).toMatch(/^cs_/);

    // La sesión generada es pagable por la vía alojada (sin API key).
    const status = await app.inject({
      method: 'GET',
      url: `/v1/checkout_sessions/${checkout_session_id}/status`,
      headers: { 'x-checkout-client-secret': client_secret },
    });
    expect(status.statusCode).toBe(200);
    expect(status.json().payment_intent.amount).toBe(45_000);

    const paid = await app.inject({
      method: 'POST',
      url: `/v1/checkout_sessions/${checkout_session_id}/confirm`,
      headers: { 'x-checkout-client-secret': client_secret },
      payload: { payment_method_token: 'tok_approve' },
    });
    expect(paid.statusCode).toBe(200);
    expect(paid.json().status).toBe('completed');
  });

  it('a disabled link no longer resolves (404) and neither does a missing one', async () => {
    const { id } = await createLink();
    await app.inject({
      method: 'POST',
      url: `/v1/payment_links/${id}/disable`,
      headers: auth(keyA),
    });
    const opened = await app.inject({ method: 'POST', url: `/v1/payment_links/${id}/sessions` });
    expect(opened.statusCode).toBe(404);
    expect(opened.json().error.code).toBe('not_found');

    const missing = await app.inject({
      method: 'POST',
      url: `/v1/payment_links/${randomUUID()}/sessions`,
    });
    expect(missing.statusCode).toBe(404);
  });
});
