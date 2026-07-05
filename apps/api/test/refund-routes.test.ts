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
 * F3-08 — refunds sobre HTTP real: idempotencia obligatoria, contrato asincrono
 * (created -> GET muestra el final), monto que excede lo remanente (422),
 * estado del intent (409), aislamiento por tenant (404) y scopes.
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
    [orgId, `refund-shop-${randomUUID().slice(0, 8)}`]
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
  posting = new PostingService(new LedgerService(appPool), appPool);
  app = buildApp({
    config,
    appPool,
    authService: new AuthService(authPool),
    identityService: new IdentityService(appPool),
    apiKeyService,
  });
  await app.ready();

  orgA = await createOrg('Refund Org A');
  orgB = await createOrg('Refund Org B');
  merchantA = await createMerchant(orgA);
  keyA = (await apiKeyService.create(orgA, { label: 'r-a', scopes: ['read', 'payments:write'] }))
    .secret;
  keyARead = (await apiKeyService.create(orgA, { label: 'r-a-ro', scopes: ['read'] })).secret;
  keyB = (await apiKeyService.create(orgB, { label: 'r-b', scopes: ['read', 'payments:write'] }))
    .secret;
}, 30_000);

afterAll(async () => {
  await app.close();
  await Promise.all([appPool.end(), authPool.end(), adminPool.end()]);
});

/**
 * Crea un intent, lo confirma (tok_approve => succeeded, captura a pending) y
 * LIBERA la liquidacion a merchant.available (el proceso de settlement real es
 * F4; aqui se siembra la precondicion para que el refund tenga de donde salir).
 */
async function seedRefundable(
  amount: number,
  key = keyA,
  merchant = merchantA,
  org = orgA
): Promise<string> {
  const created = await app.inject({
    method: 'POST',
    url: '/v1/payment_intents',
    headers: { ...auth(key), 'idempotency-key': `pi-${randomUUID()}` },
    payload: { merchant_id: merchant, amount, currency: 'COP' },
  });
  expect(created.statusCode).toBe(201);
  const intentId = created.json().id as string;

  const confirmed = await app.inject({
    method: 'POST',
    url: `/v1/payment_intents/${intentId}/confirm`,
    headers: { ...auth(key), 'idempotency-key': `cf-${randomUUID()}` },
    payload: { payment_method_token: 'tok_approve' },
  });
  expect(confirmed.statusCode).toBe(200);

  await posting.releaseSettlement({
    tenantId: org,
    merchantId: merchant,
    idempotencyKey: `settle:${intentId}`,
    sourceType: 'settlement',
    sourceId: intentId,
    amount: Money.of(amount, 'COP'),
  });
  return intentId;
}

async function getRefund(id: string, key = keyA) {
  const res = await app.inject({ method: 'GET', url: `/v1/refunds/${id}`, headers: auth(key) });
  return res;
}

describe('POST /v1/refunds (idempotente, asincrono)', () => {
  it('creates a refund, drives it to succeeded, and replays the EXACT response', async () => {
    const intentId = await seedRefundable(100_000);
    const key = `rf-${randomUUID()}`;
    const first = await app.inject({
      method: 'POST',
      url: '/v1/refunds',
      headers: { ...auth(keyA), 'idempotency-key': key },
      payload: { payment_intent_id: intentId, amount: 40_000 },
    });
    expect(first.statusCode).toBe(201);
    const body = first.json();
    expect(body.object).toBe('refund');
    expect(body.amount).toBe(40_000);
    expect(first.headers['idempotency-replayed']).toBe('false');

    // El estado final se lee via GET (contrato asincrono): fase 2 ya corrio.
    const shown = await getRefund(body.id);
    expect(shown.json().status).toBe('succeeded');

    // El intent quedo partially_refunded (40k de 100k).
    const intent = await app.inject({
      method: 'GET',
      url: `/v1/payment_intents/${intentId}`,
      headers: auth(keyA),
    });
    expect(intent.json().status).toBe('partially_refunded');
    expect(intent.json().amount_refunded).toBe(40_000);

    // Replay exacto con la misma key: misma respuesta, sin segundo refund.
    const second = await app.inject({
      method: 'POST',
      url: '/v1/refunds',
      headers: { ...auth(keyA), 'idempotency-key': key },
      payload: { payment_intent_id: intentId, amount: 40_000 },
    });
    expect(second.statusCode).toBe(201);
    expect(second.headers['idempotency-replayed']).toBe('true');
    expect(second.json()).toEqual(body);
    const list = await app.inject({
      method: 'GET',
      url: `/v1/refunds?payment_intent_id=${intentId}`,
      headers: auth(keyA),
    });
    expect(list.json().data).toHaveLength(1);
  });

  it('a full refund (no amount) empties the intent to refunded', async () => {
    const intentId = await seedRefundable(50_000);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/refunds',
      headers: { ...auth(keyA), 'idempotency-key': `rf-${randomUUID()}` },
      payload: { payment_intent_id: intentId },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().amount).toBe(50_000);
    const intent = await app.inject({
      method: 'GET',
      url: `/v1/payment_intents/${intentId}`,
      headers: auth(keyA),
    });
    expect(intent.json().status).toBe('refunded');
    expect(intent.json().amount_refunded).toBe(50_000);
  });

  it('over-refunding the remaining amount is 422 refund_amount_exceeds_remaining', async () => {
    const intentId = await seedRefundable(30_000);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/refunds',
      headers: { ...auth(keyA), 'idempotency-key': `rf-${randomUUID()}` },
      payload: { payment_intent_id: intentId, amount: 30_001 },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('refund_amount_exceeds_remaining');
  });

  it('refunding an intent that is not captured is 409 invalid_state_transition', async () => {
    // Intent recien creado (no confirmado): nada capturado.
    const created = await app.inject({
      method: 'POST',
      url: '/v1/payment_intents',
      headers: { ...auth(keyA), 'idempotency-key': `pi-${randomUUID()}` },
      payload: { merchant_id: merchantA, amount: 10_000, currency: 'COP' },
    });
    const intentId = created.json().id as string;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/refunds',
      headers: { ...auth(keyA), 'idempotency-key': `rf-${randomUUID()}` },
      payload: { payment_intent_id: intentId },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('invalid_state_transition');
  });

  it('requires the Idempotency-Key header (400)', async () => {
    const intentId = await seedRefundable(10_000);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/refunds',
      headers: auth(keyA),
      payload: { payment_intent_id: intentId },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('idempotency_key_required');
  });

  it('scope + tenant isolation: read-only 403, other tenant 404 for a foreign intent', async () => {
    const intentId = await seedRefundable(20_000);

    const readonly = await app.inject({
      method: 'POST',
      url: '/v1/refunds',
      headers: { ...auth(keyARead), 'idempotency-key': `rf-${randomUUID()}` },
      payload: { payment_intent_id: intentId },
    });
    expect(readonly.statusCode).toBe(403);
    expect(readonly.json().error.code).toBe('insufficient_scope');

    // Otro tenant: el intent es invisible -> 404 not_found (indistinguible).
    const foreign = await app.inject({
      method: 'POST',
      url: '/v1/refunds',
      headers: { ...auth(keyB), 'idempotency-key': `rf-${randomUUID()}` },
      payload: { payment_intent_id: intentId },
    });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().error.code).toBe('not_found');

    // GET del refund por el otro tenant tambien 404.
    const mineRefund = await app.inject({
      method: 'POST',
      url: '/v1/refunds',
      headers: { ...auth(keyA), 'idempotency-key': `rf-${randomUUID()}` },
      payload: { payment_intent_id: intentId },
    });
    const refundId = mineRefund.json().id as string;
    const foreignGet = await getRefund(refundId, keyB);
    expect(foreignGet.statusCode).toBe(404);
  });
});

describe('GET /v1/refunds', () => {
  it('lists refunds tenant-scoped, newest first', async () => {
    const intentId = await seedRefundable(80_000);
    await app.inject({
      method: 'POST',
      url: '/v1/refunds',
      headers: { ...auth(keyA), 'idempotency-key': `rf-${randomUUID()}` },
      payload: { payment_intent_id: intentId, amount: 10_000 },
    });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/refunds?payment_intent_id=${intentId}`,
      headers: auth(keyARead),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().object).toBe('list');
    expect(res.json().data[0].payment_intent_id).toBe(intentId);

    const foreign = await app.inject({
      method: 'GET',
      url: `/v1/refunds?payment_intent_id=${intentId}`,
      headers: auth(keyB),
    });
    expect(foreign.json().data).toHaveLength(0);
  });
});
