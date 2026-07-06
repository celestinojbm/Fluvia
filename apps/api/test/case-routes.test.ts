import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@fluvia/config';
import { createPool, type Pool } from '@fluvia/db';
import { AuthService } from '@fluvia/auth';
import { ApiKeyService, IdentityService } from '@fluvia/identity';
import { buildApp } from '../src/app.js';

/**
 * F4-03a — casos operativos sobre HTTP real: se concilia un reporte con
 * discrepancias (F4-01b) para que el trigger 0029 materialice casos, luego se
 * listan y se gobierna su ciclo (acknowledge/resolve) por el plano de API key.
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
const auth = (k: string) => ({ authorization: `Bearer ${k}` });

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

/** Crea un reporte con 1 discrepancia missing_in_ledger y lo concilia. */
async function reconcileOneDiscrepancy(): Promise<void> {
  const report = await app
    .inject({
      method: 'POST',
      url: '/v1/settlement_reports',
      headers: auth(keyA),
      payload: {
        provider: 'mock',
        currency: 'COP',
        period_start: PERIOD_START,
        period_end: PERIOD_END,
      },
    })
    .then((r) => r.json().id as string);
  await app.inject({
    method: 'POST',
    url: `/v1/settlement_reports/${report}/lines`,
    headers: auth(keyA),
    payload: {
      lines: [
        {
          provider_ref: `phantom-${randomUUID().slice(0, 8)}`,
          amount: 9_000,
          settled_at: IN_PERIOD.toISOString(),
        },
      ],
    },
  });
  await app.inject({
    method: 'POST',
    url: `/v1/settlement_reports/${report}/reconcile`,
    headers: auth(keyA),
  });
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

  orgA = await createOrg('Case Org A');
  orgB = await createOrg('Case Org B');
  merchantA = (
    await adminPool.query<{ id: string }>(
      'INSERT INTO merchants (tenant_id, name) VALUES ($1, $2) RETURNING id',
      [orgA, `case-shop-${randomUUID().slice(0, 8)}`]
    )
  ).rows[0]!.id;
  keyA = (await apiKeyService.create(orgA, { label: 'c-a', scopes: ['read', 'payments:write'] }))
    .secret;
  keyRead = (await apiKeyService.create(orgA, { label: 'c-ro', scopes: ['read'] })).secret;
  keyB = (await apiKeyService.create(orgB, { label: 'c-b', scopes: ['read', 'payments:write'] }))
    .secret;
}, 40_000);

afterAll(async () => {
  await app.close();
  await Promise.all([appPool.end(), authPool.end(), adminPool.end()]);
});

describe('casos operativos (F4-03a)', () => {
  it('materializes a case from a discrepancy, then acknowledge → resolve over HTTP', async () => {
    await seedSucceededAttempt(orgA, merchantA, `cl-${randomUUID().slice(0, 8)}`, 12_000);
    await reconcileOneDiscrepancy();

    const list = await app.inject({
      method: 'GET',
      url: '/v1/operational_cases?status=open&limit=200',
      headers: auth(keyRead),
    });
    expect(list.statusCode).toBe(200);
    const open = list.json().data as Array<{
      id: string;
      severity: string;
      status: string;
      object: string;
    }>;
    expect(open.length).toBeGreaterThanOrEqual(1);
    const target = open[0]!;
    expect(target.object).toBe('operational_case');
    expect(target.status).toBe('open');

    const acked = await app.inject({
      method: 'POST',
      url: `/v1/operational_cases/${target.id}/acknowledge`,
      headers: auth(keyA),
      payload: {},
    });
    expect(acked.statusCode).toBe(200);
    expect(acked.json().status).toBe('acknowledged');

    const resolved = await app.inject({
      method: 'POST',
      url: `/v1/operational_cases/${target.id}/resolve`,
      headers: auth(keyA),
      payload: { resolution: 'contactado el proveedor; liquida el próximo lote' },
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().status).toBe('resolved');
    expect(resolved.json().resolution).toBe('contactado el proveedor; liquida el próximo lote');

    // Re-resolver → 409 invalid_state_transition.
    const again = await app.inject({
      method: 'POST',
      url: `/v1/operational_cases/${target.id}/resolve`,
      headers: auth(keyA),
      payload: { resolution: 'otra vez' },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('invalid_state_transition');
  });

  it('requires payments:write to act and a non-empty resolution', async () => {
    await reconcileOneDiscrepancy();
    const someCase = (
      (
        await app.inject({
          method: 'GET',
          url: '/v1/operational_cases?status=open&limit=200',
          headers: auth(keyRead),
        })
      ).json().data as Array<{ id: string }>
    )[0]!;

    // read no puede resolver.
    const noScope = await app.inject({
      method: 'POST',
      url: `/v1/operational_cases/${someCase.id}/resolve`,
      headers: auth(keyRead),
      payload: { resolution: 'x' },
    });
    expect(noScope.statusCode).toBe(403);
    expect(noScope.json().error.code).toBe('insufficient_scope');

    // resolución vacía → 400 validation_error.
    const empty = await app.inject({
      method: 'POST',
      url: `/v1/operational_cases/${someCase.id}/resolve`,
      headers: auth(keyA),
      payload: { resolution: '   ' },
    });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error.code).toBe('validation_error');
  });

  it('is tenant-scoped (foreign tenant sees 404)', async () => {
    await reconcileOneDiscrepancy();
    const someCase = (
      (
        await app.inject({
          method: 'GET',
          url: '/v1/operational_cases?limit=200',
          headers: auth(keyRead),
        })
      ).json().data as Array<{ id: string }>
    )[0]!;
    const foreign = await app.inject({
      method: 'GET',
      url: `/v1/operational_cases/${someCase.id}`,
      headers: auth(keyB),
    });
    expect(foreign.statusCode).toBe(404);
  });
});
