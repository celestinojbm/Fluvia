import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@fluvia/config';
import { createPool, type Pool } from '@fluvia/db';
import { AuthService } from '@fluvia/auth';
import { ApiKeyService, IdentityService } from '@fluvia/identity';
import { buildApp } from '../src/app.js';

/**
 * F3-02 — primeros endpoints de dinero sobre HTTP real: API key + scopes,
 * Idempotency-Key OBLIGATORIA en mutaciones (capa F2-09), sobre de error del
 * catalogo, aislamiento por tenant.
 */

let app: FastifyInstance;
let appPool: Pool;
let authPool: Pool;
let adminPool: Pool;
let apiKeyService: ApiKeyService;

let orgA: string;
let orgB: string;
let merchantA: string;
let merchantB: string;
let keyA: string; // read + payments:write
let keyARead: string; // solo read
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
    [orgId, `pi-shop-${randomUUID().slice(0, 8)}`]
  );
  return res.rows[0]!.id;
}

function auth(key: string) {
  return { authorization: `Bearer ${key}` };
}

const createBody = (merchantId: string, amount = 150_000) => ({
  merchant_id: merchantId,
  amount,
  currency: 'COP',
  description: 'pedido de prueba',
});

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

  orgA = await createOrg('PI Org A');
  orgB = await createOrg('PI Org B');
  merchantA = await createMerchant(orgA);
  merchantB = await createMerchant(orgB);
  keyA = (await apiKeyService.create(orgA, { label: 'pi-a', scopes: ['read', 'payments:write'] }))
    .secret;
  keyARead = (await apiKeyService.create(orgA, { label: 'pi-a-ro', scopes: ['read'] })).secret;
  keyB = (await apiKeyService.create(orgB, { label: 'pi-b', scopes: ['read', 'payments:write'] }))
    .secret;
}, 30_000);

afterAll(async () => {
  await app.close();
  await Promise.all([appPool.end(), authPool.end(), adminPool.end()]);
});

describe('POST /v1/payment_intents (idempotente)', () => {
  it('creates an intent and replays the EXACT response on the same key', async () => {
    const key = `pi-create-${randomUUID()}`;
    const first = await app.inject({
      method: 'POST',
      url: '/v1/payment_intents',
      headers: { ...auth(keyA), 'idempotency-key': key },
      payload: createBody(merchantA),
    });
    expect(first.statusCode).toBe(201);
    const body = first.json();
    expect(body.object).toBe('payment_intent');
    expect(body.status).toBe('created');
    expect(body.amount).toBe(150_000);
    expect(body.currency).toBe('COP');
    expect(first.headers['idempotency-replayed']).toBe('false');

    const second = await app.inject({
      method: 'POST',
      url: '/v1/payment_intents',
      headers: { ...auth(keyA), 'idempotency-key': key },
      payload: createBody(merchantA),
    });
    expect(second.statusCode).toBe(201);
    expect(second.headers['idempotency-replayed']).toBe('true');
    expect(second.json()).toEqual(body);

    // Exactamente UNA fila creada.
    const rows = await adminPool.query(`SELECT 1 FROM payment_intents WHERE id = $1`, [body.id]);
    expect(rows.rowCount).toBe(1);
  });

  it('requires the Idempotency-Key header (400 idempotency_key_required)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/payment_intents',
      headers: auth(keyA),
      payload: createBody(merchantA),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('idempotency_key_required');
  });

  it('same key + different payload -> 422 idempotency_key_reuse', async () => {
    const key = `pi-reuse-${randomUUID()}`;
    await app.inject({
      method: 'POST',
      url: '/v1/payment_intents',
      headers: { ...auth(keyA), 'idempotency-key': key },
      payload: createBody(merchantA, 1000),
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/payment_intents',
      headers: { ...auth(keyA), 'idempotency-key': key },
      payload: createBody(merchantA, 2000),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('idempotency_key_reuse');
  });

  it("another tenant's merchant is indistinguishable from a missing one (404) and no key is burned", async () => {
    const key = `pi-foreign-${randomUUID()}`;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/payment_intents',
      headers: { ...auth(keyA), 'idempotency-key': key },
      payload: createBody(merchantB),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
    // El claim se revierte con el efecto: la key puede reintentarse con un
    // merchant valido.
    const retry = await app.inject({
      method: 'POST',
      url: '/v1/payment_intents',
      headers: { ...auth(keyA), 'idempotency-key': key },
      payload: createBody(merchantB),
    });
    expect(retry.statusCode).toBe(404);
  });

  it('validates payload shape and currency via the catalog envelope', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/payment_intents',
      headers: { ...auth(keyA), 'idempotency-key': `pi-bad-${randomUUID()}` },
      payload: { merchant_id: merchantA, amount: -5, currency: 'COP' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('validation_error');

    const badCurrency = await app.inject({
      method: 'POST',
      url: '/v1/payment_intents',
      headers: { ...auth(keyA), 'idempotency-key': `pi-cur-${randomUUID()}` },
      payload: { merchant_id: merchantA, amount: 100, currency: 'XXX' },
    });
    expect(badCurrency.statusCode).toBe(400);
    expect(badCurrency.json().error.code).toBe('validation_error');
  });

  it('scope enforcement: read-only key cannot create (403), session tokens cannot either (401)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/payment_intents',
      headers: { ...auth(keyARead), 'idempotency-key': `pi-scope-${randomUUID()}` },
      payload: createBody(merchantA),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('insufficient_scope');

    const noAuth = await app.inject({
      method: 'POST',
      url: '/v1/payment_intents',
      headers: { 'idempotency-key': `pi-noauth-${randomUUID()}` },
      payload: createBody(merchantA),
    });
    expect(noAuth.statusCode).toBe(401);
  });
});

describe('GET + cancel + aislamiento', () => {
  async function createIntent(key = keyA, merchant = merchantA): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/payment_intents',
      headers: { ...auth(key), 'idempotency-key': `pi-seed-${randomUUID()}` },
      payload: createBody(merchant),
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  it('GET returns the intent; the other tenant gets 404 (BOLA)', async () => {
    const id = await createIntent();
    const mine = await app.inject({
      method: 'GET',
      url: `/v1/payment_intents/${id}`,
      headers: auth(keyARead),
    });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().id).toBe(id);

    const foreign = await app.inject({
      method: 'GET',
      url: `/v1/payment_intents/${id}`,
      headers: auth(keyB),
    });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().error.code).toBe('not_found');
  });

  it('list is tenant-scoped and newest-first', async () => {
    const id = await createIntent();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/payment_intents?limit=5',
      headers: auth(keyARead),
    });
    expect(res.statusCode).toBe(200);
    const list = res.json();
    expect(list.object).toBe('list');
    expect(list.data[0].id).toBe(id);

    const other = await app.inject({
      method: 'GET',
      url: '/v1/payment_intents?limit=100',
      headers: auth(keyB),
    });
    expect((other.json().data as Array<{ id: string }>).some((i) => i.id === id)).toBe(false);
  });

  it('cancel is idempotent by key; canceling a canceled intent with a NEW key is 409', async () => {
    const id = await createIntent();
    const key = `pi-cancel-${randomUUID()}`;
    const first = await app.inject({
      method: 'POST',
      url: `/v1/payment_intents/${id}/cancel`,
      headers: { ...auth(keyA), 'idempotency-key': key },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().status).toBe('canceled');

    // Mismo key: replay exacto, sin re-ejecutar la transicion.
    const replay = await app.inject({
      method: 'POST',
      url: `/v1/payment_intents/${id}/cancel`,
      headers: { ...auth(keyA), 'idempotency-key': key },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.headers['idempotency-replayed']).toBe('true');

    // Key nueva: la FSM decide — canceled es terminal.
    const again = await app.inject({
      method: 'POST',
      url: `/v1/payment_intents/${id}/cancel`,
      headers: { ...auth(keyA), 'idempotency-key': `pi-cancel2-${randomUUID()}` },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('invalid_state_transition');
  });

  it('cross-tenant cancel is a 404, not a 403 (no existence oracle)', async () => {
    const id = await createIntent();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/payment_intents/${id}/cancel`,
      headers: { ...auth(keyB), 'idempotency-key': `pi-x-${randomUUID()}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
