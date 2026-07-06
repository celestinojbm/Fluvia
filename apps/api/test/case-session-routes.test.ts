import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@fluvia/config';
import { createPool, type Pool } from '@fluvia/db';
import { AuthService } from '@fluvia/auth';
import { ApiKeyService, IdentityService } from '@fluvia/identity';
import { buildApp } from '../src/app.js';

/**
 * F4-03c — casos y ajustes por SESIÓN: el operador humano trabaja el caso y
 * AUTORIZA ajustes con four-eyes REAL sobre HTTP. Dos miembros distintos de la
 * org (finance): U1 propone, U1 no puede aprobar su propio ajuste (409
 * four_eyes_required), U2 (distinto) lo aplica → asiento + caso resuelto.
 */

let app: FastifyInstance;
let appPool: Pool;
let authPool: Pool;
let adminPool: Pool;
let apiKeyService: ApiKeyService;

let orgA: string;
let orgB: string;
let keyA: string;

const PASSWORD = 'four eyes password 77';
const uniqueEmail = () => `fe-${randomUUID().slice(0, 12)}@example.com`;
const apiAuth = (k: string) => ({ authorization: `Bearer ${k}` });
const IN_PERIOD = new Date('2026-06-15T12:00:00Z');

async function sessionMember(role: string, orgId: string) {
  const email = uniqueEmail();
  const reg = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email, password: PASSWORD },
  });
  const { user_id, verification_token } = reg.json();
  await app.inject({
    method: 'POST',
    url: '/v1/auth/verify-email',
    payload: { token: verification_token },
  });
  await adminPool.query('INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)', [
    orgId,
    user_id,
    role,
  ]);
  const login = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email, password: PASSWORD },
  });
  return {
    headers: { authorization: `Bearer ${login.json().session_token as string}` },
    userId: user_id as string,
  };
}

async function createOrg(name: string): Promise<string> {
  const res = await adminPool.query<{ id: string }>(
    'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id',
    [name, `org-${randomUUID()}`]
  );
  return res.rows[0]!.id;
}

/** Concilia (API key) un reporte con 1 discrepancia missing_in_ledger. */
async function newCaseId(org: string, key: string): Promise<string> {
  const report = await app
    .inject({
      method: 'POST',
      url: '/v1/settlement_reports',
      headers: apiAuth(key),
      payload: {
        provider: 'mock',
        currency: 'COP',
        period_start: '2026-06-01T00:00:00Z',
        period_end: '2026-07-01T00:00:00Z',
      },
    })
    .then((r) => r.json().id as string);
  await app.inject({
    method: 'POST',
    url: `/v1/settlement_reports/${report}/lines`,
    headers: apiAuth(key),
    payload: {
      lines: [
        {
          provider_ref: `ph-${randomUUID().slice(0, 8)}`,
          amount: 9_000,
          settled_at: IN_PERIOD.toISOString(),
        },
      ],
    },
  });
  await app.inject({
    method: 'POST',
    url: `/v1/settlement_reports/${report}/reconcile`,
    headers: apiAuth(key),
  });
  const list = await app.inject({
    method: 'GET',
    url: `/v1/settlement_reports/${report}/entries`,
    headers: apiAuth(key),
  });
  void list;
  // El caso se lista por el plano de API key (F4-03a) para tomar su id.
  const cases = await app.inject({
    method: 'GET',
    url: '/v1/operational_cases?status=open&limit=200',
    headers: apiAuth(key),
  });
  return (cases.json().data as Array<{ id: string; report_id: string }>).find(
    (c) => c.report_id === report
  )!.id;
}

beforeAll(async () => {
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' }); // FOUR_EYES_THRESHOLD_MINOR=0 → siempre four-eyes
  appPool = createPool({ connectionString: config.db.app, max: 6 });
  authPool = createPool({ connectionString: config.db.auth, max: 4 });
  adminPool = createPool({ connectionString: config.db.admin, max: 2 });
  apiKeyService = new ApiKeyService(appPool);
  app = buildApp({
    config,
    appPool,
    authService: new AuthService(authPool),
    identityService: new IdentityService(appPool),
    apiKeyService,
    authRateLimits: {
      loginPerEmail: { max: 10_000, windowMs: 60_000 },
      loginPerIp: { max: 10_000, windowMs: 60_000 },
      registerPerIp: { max: 10_000, windowMs: 60_000 },
      mfaPerIp: { max: 10_000, windowMs: 60_000 },
    },
  });
  await app.ready();

  orgA = await createOrg('FE Org A');
  orgB = await createOrg('FE Org B');
  keyA = (await apiKeyService.create(orgA, { label: 'fe-a', scopes: ['payments:write', 'read'] }))
    .secret;
}, 40_000);

afterAll(async () => {
  await app.close();
  await Promise.all([appPool.end(), authPool.end(), adminPool.end()]);
});

describe('casos + ajustes con four-eyes por sesión (F4-03c)', () => {
  it('U1 proposes, cannot self-approve (409), U2 applies → asiento + case resolved', async () => {
    const caseId = await newCaseId(orgA, keyA);
    const u1 = await sessionMember('finance', orgA);
    const u2 = await sessionMember('finance', orgA);

    // U1 trabaja el caso: acknowledge.
    const ack = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgA}/operational_cases/${caseId}/acknowledge`,
      headers: u1.headers,
      payload: {},
    });
    expect(ack.statusCode).toBe(200);
    expect(ack.json().status).toBe('acknowledged');

    // U1 propone un ajuste (umbral 0 ⇒ four-eyes obligatorio).
    const proposed = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgA}/operational_cases/${caseId}/adjustments`,
      headers: u1.headers,
      payload: {
        amount: 9_000,
        currency: 'COP',
        direction: 'debit_differences',
        reason: 'diferencia',
      },
    });
    expect(proposed.statusCode).toBe(201);
    const adjId = proposed.json().id as string;
    expect(proposed.json().requires_second_approval).toBe(true);

    // U1 NO puede aprobar su propio ajuste (four-eyes) → 409.
    const self = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgA}/case_adjustments/${adjId}/approve`,
      headers: u1.headers,
    });
    expect(self.statusCode).toBe(409);
    expect(self.json().error.code).toBe('four_eyes_required');

    // U2 (distinto) sí lo aplica.
    const applied = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgA}/case_adjustments/${adjId}/approve`,
      headers: u2.headers,
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json().status).toBe('applied');
    expect(applied.json().ledger_transaction_id).not.toBeNull();

    // El caso quedó resuelto y el detalle lista el ajuste aplicado.
    const detail = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgA}/operational_cases/${caseId}`,
      headers: u2.headers,
    });
    expect(detail.json().status).toBe('resolved');
    expect((detail.json().adjustments as Array<{ status: string }>)[0]!.status).toBe('applied');
  });

  it('a role without reconciliation:manage cannot propose (403)', async () => {
    const caseId = await newCaseId(orgA, keyA);
    const ro = await sessionMember('read_only', orgA);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgA}/operational_cases/${caseId}/adjustments`,
      headers: ro.headers,
      payload: { amount: 5_000, currency: 'COP', direction: 'debit_differences', reason: 'x' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('insufficient_permissions');
  });

  it('a non-member cannot see or act on the org (404)', async () => {
    const caseId = await newCaseId(orgA, keyA);
    const outsider = await sessionMember('finance', orgB); // miembro de B, no de A
    const res = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgA}/operational_cases/${caseId}`,
      headers: outsider.headers,
    });
    expect(res.statusCode).toBe(404);
  });

  it('reject frees the case, and read_only members can still list (payments:read)', async () => {
    const caseId = await newCaseId(orgA, keyA);
    const u1 = await sessionMember('finance', orgA);
    const u2 = await sessionMember('finance', orgA);
    const proposed = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgA}/operational_cases/${caseId}/adjustments`,
      headers: u1.headers,
      payload: { amount: 9_000, currency: 'COP', direction: 'debit_differences', reason: 'r' },
    });
    const adjId = proposed.json().id as string;
    const rejected = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgA}/case_adjustments/${adjId}/reject`,
      headers: u2.headers,
      payload: { reason: 'monto incorrecto' },
    });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json().status).toBe('rejected');

    const ro = await sessionMember('read_only', orgA);
    const list = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgA}/operational_cases?limit=200`,
      headers: ro.headers,
    });
    expect(list.statusCode).toBe(200);
    expect((list.json().data as Array<{ id: string }>).some((c) => c.id === caseId)).toBe(true);
  });
});
