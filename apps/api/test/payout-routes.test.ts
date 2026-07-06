import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@fluvia/config';
import { createPool, type Pool } from '@fluvia/db';
import { AuthService } from '@fluvia/auth';
import { ApiKeyService, IdentityService } from '@fluvia/identity';
import { LedgerService, PostingService } from '@fluvia/ledger';
import { Money } from '@fluvia/money';
import { buildApp } from '../src/app.js';

/**
 * F4-07b — payouts sobre HTTP real (plano de API key): idempotencia obligatoria,
 * contrato asincrono (requested -> GET muestra el final), fundabilidad (422),
 * aislamiento por tenant (404/422) y scopes. El disponible se siembra por el
 * ledger directamente (captura + liquidacion del proveedor + release), como la
 * precondicion money-in real; el submitPayout del MockProvider aprueba => paid.
 */

let app: FastifyInstance;
let appPool: Pool;
let authPool: Pool;
let adminPool: Pool;
let apiKeyService: ApiKeyService;
let posting: PostingService;

let orgA: string;
let orgB: string;
let merchantA: string;
let keyA: string; // read + payments:write
let keyARead: string; // solo read
let keyB: string; // otro tenant

function auth(key: string) {
  return { authorization: `Bearer ${key}` };
}

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
    [orgId, `po-shop-${randomUUID().slice(0, 8)}`]
  );
  return res.rows[0]!.id;
}

/** Siembra el estado money-in completo (disponible + caja) para el comercio. */
async function seedAvailable(org: string, merchant: string, amount: number): Promise<void> {
  const src = randomUUID();
  const m = Money.of(amount, 'COP');
  await posting.capturePayment({
    tenantId: org,
    merchantId: merchant,
    idempotencyKey: `cap:${src}`,
    sourceType: 'payment_attempt',
    sourceId: src,
    amount: m,
  });
  await posting.receiveProviderSettlement({
    tenantId: org,
    merchantId: merchant,
    idempotencyKey: `prov:${src}`,
    sourceType: 'settlement',
    sourceId: src,
    amount: m,
  });
  await posting.releaseSettlement({
    tenantId: org,
    merchantId: merchant,
    idempotencyKey: `settle:${src}`,
    sourceType: 'settlement',
    sourceId: src,
    amount: m,
  });
}

async function getPayout(id: string, key = keyA) {
  return app.inject({ method: 'GET', url: `/v1/payouts/${id}`, headers: auth(key) });
}

beforeAll(async () => {
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' });
  appPool = createPool({ connectionString: config.db.app, max: 6 });
  authPool = createPool({ connectionString: config.db.auth, max: 2 });
  adminPool = createPool({ connectionString: config.db.admin, max: 2 });
  apiKeyService = new ApiKeyService(appPool);
  posting = new PostingService(new LedgerService(appPool), appPool);
  app = buildApp({
    config,
    appPool,
    authService: new AuthService(authPool),
    identityService: new IdentityService(appPool),
    apiKeyService,
  });
  await app.ready();

  orgA = await createOrg('Payout Org A');
  orgB = await createOrg('Payout Org B');
  merchantA = await createMerchant(orgA);
  keyA = (await apiKeyService.create(orgA, { label: 'p-a', scopes: ['read', 'payments:write'] }))
    .secret;
  keyARead = (await apiKeyService.create(orgA, { label: 'p-a-ro', scopes: ['read'] })).secret;
  keyB = (await apiKeyService.create(orgB, { label: 'p-b', scopes: ['read', 'payments:write'] }))
    .secret;
}, 30_000);

afterAll(async () => {
  await app.close();
  await Promise.all([appPool.end(), authPool.end(), adminPool.end()]);
});

describe('POST /v1/payouts (idempotente, asincrono)', () => {
  it('creates a payout, drives it to paid, and replays the EXACT response', async () => {
    await seedAvailable(orgA, merchantA, 100_000);
    const key = `pf-${randomUUID()}`;
    const first = await app.inject({
      method: 'POST',
      url: '/v1/payouts',
      headers: { ...auth(keyA), 'idempotency-key': key },
      payload: { merchant_id: merchantA, amount: 40_000, currency: 'COP' },
    });
    expect(first.statusCode).toBe(201);
    const body = first.json();
    expect(body.object).toBe('payout');
    expect(body.merchant_id).toBe(merchantA);
    expect(body.amount).toBe(40_000);
    expect(first.headers['idempotency-replayed']).toBe('false');

    // El estado final se lee via GET (contrato asincrono): fase 2 ya corrio.
    const shown = await getPayout(body.id);
    expect(shown.json().status).toBe('paid');

    // Replay exacto con la misma key: misma respuesta, sin segundo payout.
    const second = await app.inject({
      method: 'POST',
      url: '/v1/payouts',
      headers: { ...auth(keyA), 'idempotency-key': key },
      payload: { merchant_id: merchantA, amount: 40_000, currency: 'COP' },
    });
    expect(second.statusCode).toBe(201);
    expect(second.headers['idempotency-replayed']).toBe('true');
    expect(second.json()).toEqual(body);

    const list = await app.inject({
      method: 'GET',
      url: `/v1/payouts?merchant_id=${merchantA}`,
      headers: auth(keyA),
    });
    expect(list.json().data.filter((p: { id: string }) => p.id === body.id)).toHaveLength(1);
  });

  it('a payout exceeding the available balance is 422 payout_amount_exceeds_balance', async () => {
    const merchant = await createMerchant(orgA);
    await seedAvailable(orgA, merchant, 30_000);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/payouts',
      headers: { ...auth(keyA), 'idempotency-key': `pf-${randomUUID()}` },
      payload: { merchant_id: merchant, amount: 30_001, currency: 'COP' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('payout_amount_exceeds_balance');
  });

  it('requires the Idempotency-Key header (400)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/payouts',
      headers: auth(keyA),
      payload: { merchant_id: merchantA, amount: 1_000, currency: 'COP' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('idempotency_key_required');
  });

  it('scope + tenant isolation: read-only 403, foreign tenant cannot pay out our merchant', async () => {
    const merchant = await createMerchant(orgA);
    await seedAvailable(orgA, merchant, 20_000);

    const readonly = await app.inject({
      method: 'POST',
      url: '/v1/payouts',
      headers: { ...auth(keyARead), 'idempotency-key': `pf-${randomUUID()}` },
      payload: { merchant_id: merchant, amount: 10_000, currency: 'COP' },
    });
    expect(readonly.statusCode).toBe(403);
    expect(readonly.json().error.code).toBe('insufficient_scope');

    // Otro tenant: bajo su RLS el disponible del comercio ajeno es 0 => jamas
    // puede drenarlo (la FK de coherencia por tenant es el backstop duro).
    const foreign = await app.inject({
      method: 'POST',
      url: '/v1/payouts',
      headers: { ...auth(keyB), 'idempotency-key': `pf-${randomUUID()}` },
      payload: { merchant_id: merchant, amount: 10_000, currency: 'COP' },
    });
    expect(foreign.statusCode).toBe(422);
    expect(foreign.json().error.code).toBe('payout_amount_exceeds_balance');

    // GET del payout por el otro tenant tambien 404 (RLS lo oculta).
    const mine = await app.inject({
      method: 'POST',
      url: '/v1/payouts',
      headers: { ...auth(keyA), 'idempotency-key': `pf-${randomUUID()}` },
      payload: { merchant_id: merchant, amount: 10_000, currency: 'COP' },
    });
    const payoutId = mine.json().id as string;
    const foreignGet = await getPayout(payoutId, keyB);
    expect(foreignGet.statusCode).toBe(404);
  });
});

describe('GET /v1/payouts', () => {
  it('lists payouts tenant-scoped, newest first', async () => {
    const merchant = await createMerchant(orgA);
    await seedAvailable(orgA, merchant, 50_000);
    await app.inject({
      method: 'POST',
      url: '/v1/payouts',
      headers: { ...auth(keyA), 'idempotency-key': `pf-${randomUUID()}` },
      payload: { merchant_id: merchant, amount: 10_000, currency: 'COP' },
    });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/payouts?merchant_id=${merchant}`,
      headers: auth(keyARead),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().object).toBe('list');
    expect(res.json().data[0].merchant_id).toBe(merchant);

    const foreign = await app.inject({
      method: 'GET',
      url: `/v1/payouts?merchant_id=${merchant}`,
      headers: auth(keyB),
    });
    expect(foreign.json().data).toHaveLength(0);
  });
});
