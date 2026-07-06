import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@fluvia/config';
import { createPool, type Pool } from '@fluvia/db';
import { AuthService } from '@fluvia/auth';
import { ApiKeyService, IdentityService } from '@fluvia/identity';
import { LedgerService, PostingService } from '@fluvia/ledger';
import { Money } from '@fluvia/money';
import { DisputeService } from '@fluvia/payments-core';
import { buildApp } from '../src/app.js';

/**
 * F4-08b — disputas sobre HTTP real (plano de API key). A diferencia de payouts,
 * la disputa la ABRE el banco (no el integrador): la superficie es LECTURA (ver
 * disputas) + una accion mutante, RESPONDER con evidencia (`open ->
 * under_review`, idempotente). Las disputas se siembran por el motor (como la
 * apertura real del banco; el disponible por el ledger) y se ejercen los
 * endpoints con aislamiento por tenant y scopes.
 */

let app: FastifyInstance;
let appPool: Pool;
let authPool: Pool;
let adminPool: Pool;
let apiKeyService: ApiKeyService;
let posting: PostingService;
let disputes: DisputeService;

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
    [orgId, `dp-shop-${randomUUID().slice(0, 8)}`]
  );
  return res.rows[0]!.id;
}

/** Disponible del comercio (captura + liberacion): funda el aparte de la disputa. */
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
  await posting.releaseSettlement({
    tenantId: org,
    merchantId: merchant,
    idempotencyKey: `settle:${src}`,
    sourceType: 'settlement',
    sourceId: src,
    amount: m,
  });
}

/** El banco abre una disputa (via el motor): la precondicion de este plano. */
async function openDispute(org: string, merchant: string, amount: number): Promise<string> {
  const d = await disputes.open(org, {
    merchantId: merchant,
    amount: BigInt(amount),
    currency: 'COP',
    reason: 'fraudulent',
    providerRef: `dp_${randomUUID().slice(0, 8)}`,
  });
  return d.id;
}

beforeAll(async () => {
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' });
  appPool = createPool({ connectionString: config.db.app, max: 6 });
  authPool = createPool({ connectionString: config.db.auth, max: 2 });
  adminPool = createPool({ connectionString: config.db.admin, max: 2 });
  apiKeyService = new ApiKeyService(appPool);
  posting = new PostingService(new LedgerService(appPool), appPool);
  disputes = new DisputeService(appPool, posting);
  app = buildApp({
    config,
    appPool,
    authService: new AuthService(authPool),
    identityService: new IdentityService(appPool),
    apiKeyService,
  });
  await app.ready();

  orgA = await createOrg('Dispute Org A');
  orgB = await createOrg('Dispute Org B');
  merchantA = await createMerchant(orgA);
  keyA = (await apiKeyService.create(orgA, { label: 'd-a', scopes: ['read', 'payments:write'] }))
    .secret;
  keyARead = (await apiKeyService.create(orgA, { label: 'd-a-ro', scopes: ['read'] })).secret;
  keyB = (await apiKeyService.create(orgB, { label: 'd-b', scopes: ['read', 'payments:write'] }))
    .secret;
}, 30_000);

afterAll(async () => {
  await app.close();
  await Promise.all([appPool.end(), authPool.end(), adminPool.end()]);
});

describe('GET /v1/disputes (lectura por tenant)', () => {
  it('gets a dispute and lists it filtered by merchant, tenant-scoped', async () => {
    await seedAvailable(orgA, merchantA, 100_000);
    const id = await openDispute(orgA, merchantA, 30_000);

    const detail = await app.inject({
      method: 'GET',
      url: `/v1/disputes/${id}`,
      headers: auth(keyARead),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().object).toBe('dispute');
    expect(detail.json().status).toBe('open');
    expect(detail.json().amount).toBe(30_000);
    expect(detail.json().merchant_id).toBe(merchantA);

    const list = await app.inject({
      method: 'GET',
      url: `/v1/disputes?merchant_id=${merchantA}`,
      headers: auth(keyA),
    });
    expect(list.json().object).toBe('list');
    expect(list.json().data.filter((d: { id: string }) => d.id === id)).toHaveLength(1);

    // Otro tenant no ve ni el detalle (404) ni la lista (vacia) — RLS.
    const foreignGet = await app.inject({
      method: 'GET',
      url: `/v1/disputes/${id}`,
      headers: auth(keyB),
    });
    expect(foreignGet.statusCode).toBe(404);
    const foreignList = await app.inject({
      method: 'GET',
      url: `/v1/disputes?merchant_id=${merchantA}`,
      headers: auth(keyB),
    });
    expect(foreignList.json().data).toHaveLength(0);
  });

  it('a nonexistent dispute is 404 not_found', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/disputes/${randomUUID()}`,
      headers: auth(keyA),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
  });
});

describe('POST /v1/disputes/:id/evidence (open -> under_review, idempotente)', () => {
  it('submits evidence, is idempotent, and requires payments:write', async () => {
    const merchant = await createMerchant(orgA);
    await seedAvailable(orgA, merchant, 100_000);
    const id = await openDispute(orgA, merchant, 50_000);

    // read-only no puede responder.
    const readonly = await app.inject({
      method: 'POST',
      url: `/v1/disputes/${id}/evidence`,
      headers: auth(keyARead),
    });
    expect(readonly.statusCode).toBe(403);
    expect(readonly.json().error.code).toBe('insufficient_scope');

    const first = await app.inject({
      method: 'POST',
      url: `/v1/disputes/${id}/evidence`,
      headers: auth(keyA),
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().status).toBe('under_review');

    // Re-enviar es idempotente: mismo estado, sin error.
    const again = await app.inject({
      method: 'POST',
      url: `/v1/disputes/${id}/evidence`,
      headers: auth(keyA),
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().status).toBe('under_review');
  });

  it('submitting evidence on a resolved dispute is 409 invalid_state_transition', async () => {
    const merchant = await createMerchant(orgA);
    await seedAvailable(orgA, merchant, 100_000);
    const id = await openDispute(orgA, merchant, 20_000);
    // El banco resuelve la disputa (fuente verificada) antes de responder.
    await disputes.resolve(orgA, { disputeId: id, outcome: 'won' });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/disputes/${id}/evidence`,
      headers: auth(keyA),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('invalid_state_transition');
  });
});
