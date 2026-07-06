import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@fluvia/config';
import { createPool, type Pool } from '@fluvia/db';
import { AuthService } from '@fluvia/auth';
import { ApiKeyService, IdentityService } from '@fluvia/identity';
import { buildApp } from '../src/app.js';

/**
 * F4-01b — gestión de conciliación sobre HTTP real: cargar el reporte de
 * liquidación (líneas), conciliar contra los intentos `succeeded` del tenant y
 * consultar el resultado. Se siembran intentos succeeded con el pool admin.
 */

let app: FastifyInstance;
let appPool: Pool;
let authPool: Pool;
let adminPool: Pool;

let orgA: string;
let orgB: string;
let merchantA: string;
let keyA: string;
let keyRead: string;
let keyB: string;

const PERIOD_START = '2026-06-01T00:00:00Z';
const PERIOD_END = '2026-07-01T00:00:00Z';
const IN_PERIOD = new Date('2026-06-15T12:00:00Z');

async function createOrg(name: string): Promise<string> {
  const res = await adminPool.query<{ id: string }>(
    'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id',
    [name, `org-${randomUUID()}`]
  );
  return res.rows[0]!.id;
}
async function seedSucceededAttempt(org: string, merchant: string, ref: string, amount: number) {
  const intent = (
    await adminPool.query<{ id: string }>(
      `INSERT INTO payment_intents
         (tenant_id, merchant_id, amount, currency, status, capture_method, amount_captured, succeeded_at)
       VALUES ($1, $2, $3, 'COP', 'succeeded', 'automatic', $3, $4) RETURNING id`,
      [org, merchant, amount, IN_PERIOD]
    )
  ).rows[0]!.id;
  await adminPool.query(
    `INSERT INTO payment_attempts
       (tenant_id, intent_id, attempt_number, provider, provider_ref, status, amount, currency, resolved_at)
     VALUES ($1, $2, 1, 'mock', $3, 'succeeded', $4, 'COP', $5)`,
    [org, intent, ref, amount, IN_PERIOD]
  );
}
const auth = (k: string) => ({ authorization: `Bearer ${k}` });

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

  orgA = await createOrg('Settle Org A');
  orgB = await createOrg('Settle Org B');
  merchantA = (
    await adminPool.query<{ id: string }>(
      'INSERT INTO merchants (tenant_id, name) VALUES ($1, $2) RETURNING id',
      [orgA, `settle-shop-${randomUUID().slice(0, 8)}`]
    )
  ).rows[0]!.id;
  keyA = (await apiKeyService.create(orgA, { label: 's-a', scopes: ['read', 'payments:write'] }))
    .secret;
  keyRead = (await apiKeyService.create(orgA, { label: 's-ro', scopes: ['read'] })).secret;
  keyB = (await apiKeyService.create(orgB, { label: 's-b', scopes: ['read', 'payments:write'] }))
    .secret;
}, 40_000);

afterAll(async () => {
  await app.close();
  await Promise.all([appPool.end(), authPool.end(), adminPool.end()]);
});

async function createReport(key = keyA) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/settlement_reports',
    headers: auth(key),
    payload: {
      provider: 'mock',
      currency: 'COP',
      period_start: PERIOD_START,
      period_end: PERIOD_END,
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

describe('gestión de conciliación', () => {
  it('loads lines, reconciles and reports the discrepancy summary', async () => {
    await seedSucceededAttempt(orgA, merchantA, 'sref_match', 50_000);
    await seedSucceededAttempt(orgA, merchantA, 'sref_only_ledger', 20_000);
    const reportId = await createReport();

    const added = await app.inject({
      method: 'POST',
      url: `/v1/settlement_reports/${reportId}/lines`,
      headers: auth(keyA),
      payload: {
        lines: [
          { provider_ref: 'sref_match', amount: 50_000, settled_at: IN_PERIOD.toISOString() },
          {
            provider_ref: 'sref_only_provider',
            amount: 15_000,
            settled_at: IN_PERIOD.toISOString(),
          },
        ],
      },
    });
    expect(added.statusCode).toBe(200);
    expect(added.json().inserted).toBe(2);

    const rec = await app.inject({
      method: 'POST',
      url: `/v1/settlement_reports/${reportId}/reconcile`,
      headers: auth(keyA),
    });
    expect(rec.statusCode).toBe(200);
    expect(rec.json().summary).toEqual({
      matched: 1,
      amount_mismatch: 0,
      missing_at_provider: 1, // sref_only_ledger
      missing_in_ledger: 1, // sref_only_provider
    });

    const got = await app.inject({
      method: 'GET',
      url: `/v1/settlement_reports/${reportId}`,
      headers: auth(keyRead),
    });
    expect(got.statusCode).toBe(200);
    expect(got.json().status).toBe('reconciled');
    expect(got.json().summary.matched).toBe(1);

    const missing = await app.inject({
      method: 'GET',
      url: `/v1/settlement_reports/${reportId}/entries?status=missing_in_ledger`,
      headers: auth(keyRead),
    });
    expect(missing.statusCode).toBe(200);
    const data = missing.json().data as Array<{ provider_ref: string; provider_amount: number }>;
    expect(data).toHaveLength(1);
    expect(data[0]!.provider_ref).toBe('sref_only_provider');
    expect(data[0]!.provider_amount).toBe(15_000);
  });

  it('refuses to reconcile a report twice (409)', async () => {
    const reportId = await createReport();
    await app.inject({
      method: 'POST',
      url: `/v1/settlement_reports/${reportId}/reconcile`,
      headers: auth(keyA),
    });
    const again = await app.inject({
      method: 'POST',
      url: `/v1/settlement_reports/${reportId}/reconcile`,
      headers: auth(keyA),
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('invalid_state_transition');
  });

  it('requires payments:write to create and is tenant-scoped', async () => {
    const noScope = await app.inject({
      method: 'POST',
      url: '/v1/settlement_reports',
      headers: auth(keyRead),
      payload: {
        provider: 'mock',
        currency: 'COP',
        period_start: PERIOD_START,
        period_end: PERIOD_END,
      },
    });
    expect(noScope.statusCode).toBe(403);
    expect(noScope.json().error.code).toBe('insufficient_scope');

    const reportId = await createReport();
    const foreign = await app.inject({
      method: 'GET',
      url: `/v1/settlement_reports/${reportId}`,
      headers: auth(keyB),
    });
    expect(foreign.statusCode).toBe(404);
  });

  it('lists reports for the tenant', async () => {
    const reportId = await createReport();
    const list = await app.inject({
      method: 'GET',
      url: '/v1/settlement_reports?limit=100',
      headers: auth(keyRead),
    });
    expect(list.statusCode).toBe(200);
    expect((list.json().data as Array<{ id: string }>).some((r) => r.id === reportId)).toBe(true);
  });
});
