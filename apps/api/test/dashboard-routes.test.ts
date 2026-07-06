import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@fluvia/config';
import { createPool, type Pool } from '@fluvia/db';
import { AuthService } from '@fluvia/auth';
import { ApiKeyService, IdentityService } from '@fluvia/identity';
import { buildApp } from '../src/app.js';

/**
 * F3-09b-i — plano de LECTURA del dashboard: el operador HUMANO autentica por
 * sesión y su organización (= tenant) sale de su membresía (`payments:read`).
 * Los datos se crean por el plano de API key (creación real) y se leen por el
 * plano de sesión — prueba ambos planos y el aislamiento por membresía/tenant.
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
let intentId: string;

const PASSWORD = 'dashboard password 77';
const uniqueEmail = () => `dash-${randomUUID().slice(0, 12)}@example.com`;

async function sessionUser(role?: string, orgId?: string) {
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
  if (role && orgId) {
    await adminPool.query(
      'INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)',
      [orgId, user_id, role]
    );
  }
  const login = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email, password: PASSWORD },
  });
  return { headers: { authorization: `Bearer ${login.json().session_token as string}` } };
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
    [orgId, `dash-shop-${randomUUID().slice(0, 8)}`]
  );
  return res.rows[0]!.id;
}
async function seedDeadWebhook(
  orgId: string,
  status: 'dead' | 'delivered' = 'dead'
): Promise<string> {
  const ep = await adminPool.query<{ id: string }>(
    `INSERT INTO webhook_endpoints (tenant_id, url, secret_enc, events)
     VALUES ($1, 'https://example.test/hook', 'enc:dummy', '{}') RETURNING id`,
    [orgId]
  );
  const ev = await adminPool.query<{ id: string }>(
    `INSERT INTO webhook_events (tenant_id, endpoint_id, topic, payload, status, attempts)
     VALUES ($1, $2, 'merchant.updated', '{}'::jsonb, $3, $4) RETURNING id`,
    [orgId, ep.rows[0]!.id, status, status === 'dead' ? 7 : 0]
  );
  return ev.rows[0]!.id;
}
const apiAuth = (key: string) => ({ authorization: `Bearer ${key}` });

beforeAll(async () => {
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' });
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

  orgA = await createOrg('Dash Org A');
  orgB = await createOrg('Dash Org B');
  merchantA = await createMerchant(orgA);
  keyA = (await apiKeyService.create(orgA, { label: 'dash-a', scopes: ['payments:write', 'read'] }))
    .secret;

  // Datos reales por el plano de API key.
  const intent = await app.inject({
    method: 'POST',
    url: '/v1/payment_intents',
    headers: { ...apiAuth(keyA), 'idempotency-key': `pi-${randomUUID()}` },
    payload: { merchant_id: merchantA, amount: 90_000, currency: 'COP' },
  });
  intentId = intent.json().id;
  await app.inject({
    method: 'POST',
    url: '/v1/payment_links',
    headers: { ...apiAuth(keyA), 'idempotency-key': `pl-${randomUUID()}` },
    payload: { merchant_id: merchantA, amount: 25_000, currency: 'COP' },
  });
}, 40_000);

afterAll(async () => {
  await app.close();
  await Promise.all([appPool.end(), authPool.end(), adminPool.end()]);
});

describe('lectura por sesión + membresía', () => {
  it('a member lists and details payment intents created via the API-key plane', async () => {
    const owner = await sessionUser('owner', orgA);
    const list = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgA}/payment_intents?limit=100`,
      headers: owner.headers,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().object).toBe('list');
    expect((list.json().data as Array<{ id: string }>).some((i) => i.id === intentId)).toBe(true);

    const detail = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgA}/payment_intents/${intentId}`,
      headers: owner.headers,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().object).toBe('payment_intent');
    expect(detail.json().amount).toBe(90_000);
  });

  it('exposes the full operational read plane (all resources wired + guarded)', async () => {
    const owner = await sessionUser('read_only', orgA);
    for (const resource of [
      'payment_intents',
      'refunds',
      'payouts',
      'disputes',
      'checkout_sessions',
      'payment_links',
      'webhook_events',
    ]) {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/organizations/${orgA}/${resource}`,
        headers: owner.headers,
      });
      expect(res.statusCode, resource).toBe(200);
      expect(res.json().object, resource).toBe('list');
    }
    // El payment link creado es visible por el plano de operador.
    const links = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgA}/payment_links`,
      headers: owner.headers,
    });
    expect((links.json().data as unknown[]).length).toBeGreaterThanOrEqual(1);
  });
});

describe('aislamiento y autenticación', () => {
  it('a non-member (member of another org) gets 404 for a foreign org', async () => {
    const outsider = await sessionUser('owner', orgB);
    const res = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgA}/payment_intents`,
      headers: outsider.headers,
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects a request without a session (401)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgA}/payment_intents`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("does not leak another tenant's intent by id even to a member", async () => {
    const owner = await sessionUser('owner', orgB);
    const res = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgB}/payment_intents/${intentId}`,
      headers: owner.headers,
    });
    // orgB member, but the intent belongs to orgA -> not found under RLS.
    expect(res.statusCode).toBe(404);
  });
});

describe('reenvío de webhooks dead por sesión (webhooks:manage)', () => {
  it('an admin resends a dead event as a fresh pending one', async () => {
    const dead = await seedDeadWebhook(orgA);
    const admin = await sessionUser('admin', orgA);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgA}/webhook_events/${dead}/resend`,
      headers: admin.headers,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('pending');
    expect(res.json().resent_from_event_id).toBe(dead);
  });

  it('a read_only role lacks webhooks:manage (403)', async () => {
    const dead = await seedDeadWebhook(orgA);
    const ro = await sessionUser('read_only', orgA);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgA}/webhook_events/${dead}/resend`,
      headers: ro.headers,
    });
    expect(res.statusCode).toBe(403);
  });

  it('refuses to resend a non-dead event (409) and 404s for a non-member', async () => {
    const delivered = await seedDeadWebhook(orgA, 'delivered');
    const admin = await sessionUser('admin', orgA);
    const notDead = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgA}/webhook_events/${delivered}/resend`,
      headers: admin.headers,
    });
    expect(notDead.statusCode).toBe(409);

    const dead = await seedDeadWebhook(orgA);
    const outsider = await sessionUser('admin', orgB);
    const foreign = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgA}/webhook_events/${dead}/resend`,
      headers: outsider.headers,
    });
    expect(foreign.statusCode).toBe(404);
  });
});

describe('conciliación por sesión (F4-01c)', () => {
  it('lists reports, shows the summary and drills into discrepancies', async () => {
    // Lado ledger: un intento succeeded en periodo.
    const inPeriod = new Date('2026-06-15T12:00:00Z');
    const intent = (
      await adminPool.query<{ id: string }>(
        `INSERT INTO payment_intents
           (tenant_id, merchant_id, amount, currency, status, capture_method, amount_captured, succeeded_at)
         VALUES ($1, $2, 40000, 'COP', 'succeeded', 'automatic', 40000, $3) RETURNING id`,
        [orgA, merchantA, inPeriod]
      )
    ).rows[0]!.id;
    await adminPool.query(
      `INSERT INTO payment_attempts
         (tenant_id, intent_id, attempt_number, provider, provider_ref, status, amount, currency, resolved_at)
       VALUES ($1, $2, 1, 'mock', 'dref_match', 'succeeded', 40000, 'COP', $3)`,
      [orgA, intent, inPeriod]
    );
    // Reporte + líneas + reconcile por el plano de API key.
    const reportId = (
      await app.inject({
        method: 'POST',
        url: '/v1/settlement_reports',
        headers: apiAuth(keyA),
        payload: {
          provider: 'mock',
          currency: 'COP',
          period_start: '2026-06-01T00:00:00Z',
          period_end: '2026-07-01T00:00:00Z',
        },
      })
    ).json().id;
    await app.inject({
      method: 'POST',
      url: `/v1/settlement_reports/${reportId}/lines`,
      headers: apiAuth(keyA),
      payload: {
        lines: [
          { provider_ref: 'dref_match', amount: 40000, settled_at: inPeriod.toISOString() },
          { provider_ref: 'dref_phantom', amount: 9000, settled_at: inPeriod.toISOString() },
        ],
      },
    });
    await app.inject({
      method: 'POST',
      url: `/v1/settlement_reports/${reportId}/reconcile`,
      headers: apiAuth(keyA),
    });

    // Lectura por sesión (operador).
    const owner = await sessionUser('owner', orgA);
    const list = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgA}/settlement_reports?limit=100`,
      headers: owner.headers,
    });
    expect(list.statusCode).toBe(200);
    expect((list.json().data as Array<{ id: string }>).some((r) => r.id === reportId)).toBe(true);

    const detail = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgA}/settlement_reports/${reportId}`,
      headers: owner.headers,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().status).toBe('reconciled');
    expect(detail.json().summary.matched).toBe(1);
    expect(detail.json().summary.missing_in_ledger).toBe(1);

    const missing = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgA}/settlement_reports/${reportId}/entries?status=missing_in_ledger`,
      headers: owner.headers,
    });
    expect((missing.json().data as Array<{ provider_ref: string }>)[0]!.provider_ref).toBe(
      'dref_phantom'
    );
  });

  it('a non-member cannot read the reconciliation of a foreign org (404)', async () => {
    const reportId = (
      await app.inject({
        method: 'POST',
        url: '/v1/settlement_reports',
        headers: apiAuth(keyA),
        payload: {
          provider: 'mock',
          currency: 'COP',
          period_start: '2026-06-01T00:00:00Z',
          period_end: '2026-07-01T00:00:00Z',
        },
      })
    ).json().id;
    const outsider = await sessionUser('owner', orgB);
    const res = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgA}/settlement_reports/${reportId}`,
      headers: outsider.headers,
    });
    expect(res.statusCode).toBe(404);
  });
});
