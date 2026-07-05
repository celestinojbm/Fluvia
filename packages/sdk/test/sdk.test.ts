import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@fluvia/config';
import { createPool, type Pool } from '@fluvia/db';
import { AuthService } from '@fluvia/auth';
import { ApiKeyService, IdentityService } from '@fluvia/identity';
import { buildApp } from '@fluvia/api';
import { FluviaApiError, FluviaClient } from '../src/index.js';

type App = ReturnType<typeof buildApp>;

/**
 * El SDK ejercido contra el API REAL en proceso: el transporte `fetch` delega en
 * `app.inject` (Fastify), así que cada llamada pasa por la autenticación, la
 * idempotencia y la lógica de dominio reales — no un mock.
 */

let app: App;
let appPool: Pool;
let authPool: Pool;
let adminPool: Pool;
let client: FluviaClient;
let merchantId: string;

function injectFetch(instance: App): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const res = await instance.inject({
      method: (init?.method ?? 'GET') as 'GET' | 'POST',
      url: u.pathname + u.search,
      headers: (init?.headers as Record<string, string>) ?? {},
      payload: init?.body ? String(init.body) : undefined,
    });
    const headers = new Headers();
    for (const [k, v] of Object.entries(res.headers)) {
      if (typeof v === 'string') headers.set(k, v);
    }
    return new Response(res.payload, { status: res.statusCode, headers });
  }) as unknown as typeof fetch;
}

beforeAll(async () => {
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' });
  appPool = createPool({ connectionString: config.db.app, max: 6 });
  authPool = createPool({ connectionString: config.db.auth, max: 2 });
  adminPool = createPool({ connectionString: config.db.admin, max: 2 });
  const apiKeyService = new ApiKeyService(appPool);
  app = buildApp({
    config,
    appPool,
    authService: new AuthService(authPool),
    identityService: new IdentityService(appPool),
    apiKeyService,
  });
  await app.ready();

  const org = (
    await adminPool.query<{ id: string }>(
      'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id',
      ['SDK Org', `org-${randomUUID()}`]
    )
  ).rows[0]!.id;
  merchantId = (
    await adminPool.query<{ id: string }>(
      'INSERT INTO merchants (tenant_id, name) VALUES ($1, $2) RETURNING id',
      [org, `sdk-shop-${randomUUID().slice(0, 8)}`]
    )
  ).rows[0]!.id;
  const apiKey = (
    await apiKeyService.create(org, {
      label: 'sdk',
      scopes: ['read', 'payments:write', 'customers:write', 'webhooks:manage'],
    })
  ).secret;

  client = new FluviaClient({
    baseUrl: 'http://sdk.test',
    apiKey,
    fetchImpl: injectFetch(app),
  });
}, 40_000);

afterAll(async () => {
  await app.close();
  await Promise.all([appPool.end(), authPool.end(), adminPool.end()]);
});

describe('payment intents', () => {
  it('creates (auto idempotency-key), gets and lists', async () => {
    const intent = await client.paymentIntents.create({
      merchant_id: merchantId,
      amount: 80_000,
      currency: 'COP',
    });
    expect(intent.object).toBe('payment_intent');
    expect(intent.amount).toBe(80_000);

    const got = await client.paymentIntents.get(intent.id);
    expect(got.id).toBe(intent.id);

    const list = await client.paymentIntents.list({ limit: 100 });
    expect(list.object).toBe('list');
    expect(list.data.some((i) => i.id === intent.id)).toBe(true);
  });

  it('replays the same response for a reused idempotency key', async () => {
    const key = `sdk-${randomUUID()}`;
    const a = await client.paymentIntents.create(
      { merchant_id: merchantId, amount: 12_000, currency: 'COP' },
      key
    );
    const b = await client.paymentIntents.create(
      { merchant_id: merchantId, amount: 12_000, currency: 'COP' },
      key
    );
    expect(b.id).toBe(a.id);
  });

  it('confirms an intent and refunds it', async () => {
    const intent = await client.paymentIntents.create({
      merchant_id: merchantId,
      amount: 50_000,
      currency: 'COP',
    });
    // Contrato asíncrono: confirm devuelve `processing`; el GET refleja el
    // desenlace (tok_approve liquida en el mismo request → succeeded).
    const confirmed = await client.paymentIntents.confirm(intent.id, 'tok_approve');
    expect(confirmed.status).toBe('processing');
    const settled = await client.paymentIntents.get(intent.id);
    expect(settled.status).toBe('succeeded');

    const refund = await client.refunds.create({ payment_intent_id: intent.id, amount: 20_000 });
    expect(refund.object).toBe('refund');
    expect(refund.payment_intent_id).toBe(intent.id);
    const gotRefund = await client.refunds.get(refund.id);
    expect(gotRefund.id).toBe(refund.id);
  });
});

describe('customers, links and webhook endpoints', () => {
  it('creates, updates and deletes a customer', async () => {
    const c = await client.customers.create({ email: 'a@b.co', name: 'Ada' });
    expect(c.email).toBe('a@b.co');
    const updated = await client.customers.update(c.id, { name: 'Ada L.' });
    expect(updated.name).toBe('Ada L.');
    const del = await client.customers.delete(c.id);
    expect(del.deleted).toBe(true);
  });

  it('creates and disables a payment link', async () => {
    const link = await client.paymentLinks.create({
      merchant_id: merchantId,
      amount: 30_000,
      currency: 'COP',
    });
    expect(link.url).toContain(`/l/${link.id}`);
    const disabled = await client.paymentLinks.disable(link.id);
    expect(disabled.status).toBe('disabled');
  });

  it('creates, lists and rotates a webhook endpoint (secret shown once)', async () => {
    const ep = await client.webhookEndpoints.create({ url: 'https://example.test/hook' });
    expect(ep.secret).toBeTruthy();
    const list = await client.webhookEndpoints.list();
    expect(list.data.some((e) => e.id === ep.id)).toBe(true);
    const rotated = await client.webhookEndpoints.rotate(ep.id);
    expect(rotated.secret).toBeTruthy();
    expect(rotated.secret).not.toBe(ep.secret);
  });
});

describe('typed errors', () => {
  it('throws FluviaApiError with the stable code on not-found', async () => {
    await expect(client.paymentIntents.get(randomUUID())).rejects.toMatchObject({
      name: 'FluviaApiError',
      status: 404,
      code: 'not_found',
    });
  });

  it('throws on an insufficient scope', async () => {
    const roClient = new FluviaClient({
      baseUrl: 'http://sdk.test',
      apiKey: 'fluvia_sk_not_a_real_key',
      fetchImpl: injectFetch(app),
    });
    try {
      await roClient.paymentIntents.list();
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(FluviaApiError);
      expect((err as FluviaApiError).status).toBe(401);
    }
  });
});
