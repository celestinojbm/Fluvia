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
let posting: PostingService;
let disputeService: DisputeService;

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

/** El banco abre una disputa (vía el motor): funda el disponible y aparta el
 *  monto, dejándola `open` para ejercer la acción de respuesta por sesión. */
async function seedOpenDispute(org: string, merchant: string, amount: number): Promise<string> {
  const src = randomUUID();
  const m = Money.of(amount * 2, 'COP');
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
  const d = await disputeService.open(org, {
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
  authPool = createPool({ connectionString: config.db.auth, max: 4 });
  adminPool = createPool({ connectionString: config.db.admin, max: 2 });
  apiKeyService = new ApiKeyService(appPool);
  posting = new PostingService(new LedgerService(appPool), appPool);
  disputeService = new DisputeService(appPool, posting);
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

describe('responder a disputa con evidencia por sesión (F4-08e, reconciliation:manage)', () => {
  it('finance responds with evidence (open -> under_review), idempotently', async () => {
    const merchant = await createMerchant(orgA);
    const id = await seedOpenDispute(orgA, merchant, 30_000);
    const finance = await sessionUser('finance', orgA);

    const first = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgA}/disputes/${id}/evidence`,
      headers: finance.headers,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().object).toBe('dispute');
    expect(first.json().status).toBe('under_review');

    // Re-responder es idempotente: mismo estado terminal-de-respuesta, sin error.
    const again = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgA}/disputes/${id}/evidence`,
      headers: finance.headers,
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().status).toBe('under_review');
  });

  it('a read_only role lacks reconciliation:manage (403)', async () => {
    const merchant = await createMerchant(orgA);
    const id = await seedOpenDispute(orgA, merchant, 20_000);
    const ro = await sessionUser('read_only', orgA);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgA}/disputes/${id}/evidence`,
      headers: ro.headers,
    });
    expect(res.statusCode).toBe(403);
  });

  it('404s for a non-member acting on a foreign org', async () => {
    const merchant = await createMerchant(orgA);
    const id = await seedOpenDispute(orgA, merchant, 15_000);
    const outsider = await sessionUser('finance', orgB);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgA}/disputes/${id}/evidence`,
      headers: outsider.headers,
    });
    expect(res.statusCode).toBe(404);
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

// ── F6.5A-bis — escrituras del plano de sesión (G1 refunds, G2 payment links) ──

/** Un intent REEMBOLSABLE: succeeded con todo capturado (insert directo, como
 *  el seed de conciliación — el plano de API key no llega a succeeded sin
 *  confirmación del comprador). */
async function seedSucceededIntent(orgId: string, merchant: string, amount: number) {
  const res = await adminPool.query<{ id: string }>(
    `INSERT INTO payment_intents
       (tenant_id, merchant_id, amount, currency, status, capture_method, amount_captured, succeeded_at)
     VALUES ($1, $2, $3, 'COP', 'succeeded', 'automatic', $3, now()) RETURNING id`,
    [orgId, merchant, amount]
  );
  return res.rows[0]!.id;
}

describe('crear refund por sesión (F6.5A-bis G1, reconciliation:manage)', () => {
  it('finance creates a refund with an Idempotency-Key; replay returns the same refund without duplicating', async () => {
    const merchant = await createMerchant(orgA);
    const intent = await seedSucceededIntent(orgA, merchant, 50_000);
    const finance = await sessionUser('finance', orgA);
    const key = `dash-refund-${randomUUID()}`;

    const first = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgA}/refunds`,
      headers: { ...finance.headers, 'idempotency-key': key },
      payload: { payment_intent_id: intent, amount: 20_000, reason: 'requested by customer' },
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().object).toBe('refund');
    expect(first.json().amount).toBe(20_000);
    expect(first.headers['idempotency-replayed']).toBe('false');

    const replay = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgA}/refunds`,
      headers: { ...finance.headers, 'idempotency-key': key },
      payload: { payment_intent_id: intent, amount: 20_000, reason: 'requested by customer' },
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json().id).toBe(first.json().id);
    expect(replay.headers['idempotency-replayed']).toBe('true');

    // Sin duplicado: un solo refund para el intent.
    const list = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgA}/refunds?payment_intent_id=${intent}`,
      headers: finance.headers,
    });
    expect((list.json().data as unknown[]).length).toBe(1);
  });

  it('audits the creation atomically as actor user (refund.created)', async () => {
    const merchant = await createMerchant(orgA);
    const intent = await seedSucceededIntent(orgA, merchant, 30_000);
    const admin = await sessionUser('admin', orgA);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgA}/refunds`,
      headers: { ...admin.headers, 'idempotency-key': `dash-refund-${randomUUID()}` },
      payload: { payment_intent_id: intent },
    });
    expect(res.statusCode).toBe(201);
    // Sin amount => reembolsa todo lo remanente.
    expect(res.json().amount).toBe(30_000);

    const audit = await adminPool.query(
      `SELECT actor_type, auth_method, result FROM audit_events
       WHERE tenant_id = $1 AND action = 'refund.created' AND resource_id = $2`,
      [orgA, res.json().id]
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0]).toMatchObject({
      actor_type: 'user',
      auth_method: 'session',
      result: 'success',
    });
  });

  it('mirrors the API-key serializer exactly (same resource shape)', async () => {
    const merchant = await createMerchant(orgA);
    const viaSession = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgA}/refunds`,
      headers: {
        ...(await sessionUser('owner', orgA)).headers,
        'idempotency-key': `dash-refund-${randomUUID()}`,
      },
      payload: {
        payment_intent_id: await seedSucceededIntent(orgA, merchant, 10_000),
      },
    });
    const viaApiKey = await app.inject({
      method: 'POST',
      url: '/v1/refunds',
      headers: { ...apiAuth(keyA), 'idempotency-key': `key-refund-${randomUUID()}` },
      payload: {
        payment_intent_id: await seedSucceededIntent(orgA, merchant, 10_000),
      },
    });
    expect(viaSession.statusCode).toBe(201);
    expect(viaApiKey.statusCode).toBe(201);
    expect(Object.keys(viaSession.json()).sort()).toEqual(Object.keys(viaApiKey.json()).sort());
  });

  it('requires the Idempotency-Key header (400 idempotency_key_required)', async () => {
    const merchant = await createMerchant(orgA);
    const intent = await seedSucceededIntent(orgA, merchant, 10_000);
    const owner = await sessionUser('owner', orgA);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgA}/refunds`,
      headers: owner.headers,
      payload: { payment_intent_id: intent },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('idempotency_key_required');
  });

  it('rejects roles without reconciliation:manage (403) — the read plane stays readable for them', async () => {
    const merchant = await createMerchant(orgA);
    const intent = await seedSucceededIntent(orgA, merchant, 10_000);
    for (const role of ['analyst', 'read_only', 'support', 'developer']) {
      const user = await sessionUser(role, orgA);
      const res = await app.inject({
        method: 'POST',
        url: `/v1/organizations/${orgA}/refunds`,
        headers: { ...user.headers, 'idempotency-key': `dash-refund-${randomUUID()}` },
        payload: { payment_intent_id: intent },
      });
      expect(res.statusCode, role).toBe(403);
      // Y sigue pudiendo LEER (payments:read universal).
      const read = await app.inject({
        method: 'GET',
        url: `/v1/organizations/${orgA}/refunds`,
        headers: user.headers,
      });
      expect(read.statusCode, role).toBe(200);
    }
  });

  it('404s for a non-member and cannot refund a foreign intent (cross-tenant)', async () => {
    const merchant = await createMerchant(orgA);
    const intent = await seedSucceededIntent(orgA, merchant, 10_000);
    // No-miembro de orgA: la org es invisible.
    const outsider = await sessionUser('owner', orgB);
    const foreignOrg = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgA}/refunds`,
      headers: { ...outsider.headers, 'idempotency-key': `dash-refund-${randomUUID()}` },
      payload: { payment_intent_id: intent },
    });
    expect(foreignOrg.statusCode).toBe(404);
    // Miembro de orgB apuntando a un intent de orgA: RLS lo hace invisible.
    const crossIntent = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgB}/refunds`,
      headers: { ...outsider.headers, 'idempotency-key': `dash-refund-${randomUUID()}` },
      payload: { payment_intent_id: intent },
    });
    expect(crossIntent.statusCode).toBe(404);
    // Nada se creó para ese intent.
    const ownerA = await sessionUser('owner', orgA);
    const list = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgA}/refunds?payment_intent_id=${intent}`,
      headers: ownerA.headers,
    });
    expect((list.json().data as unknown[]).length).toBe(0);
  });
});

describe('crear payment link por sesión (F6.5A-bis G2, reconciliation:manage)', () => {
  it('owner creates a link idempotently, audited as actor user, mirroring the API-key serializer', async () => {
    const owner = await sessionUser('owner', orgA);
    const key = `dash-link-${randomUUID()}`;
    const payload = {
      merchant_id: merchantA,
      amount: 15_000,
      currency: 'COP',
      description: 'F6.5A-bis',
    };

    const first = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgA}/payment_links`,
      headers: { ...owner.headers, 'idempotency-key': key },
      payload,
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().object).toBe('payment_link');
    expect(first.json().status).toBe('active');
    expect(first.json().url).toContain(first.json().id);

    const replay = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgA}/payment_links`,
      headers: { ...owner.headers, 'idempotency-key': key },
      payload,
    });
    expect(replay.json().id).toBe(first.json().id);
    expect(replay.headers['idempotency-replayed']).toBe('true');

    const audit = await adminPool.query(
      `SELECT actor_type, auth_method FROM audit_events
       WHERE tenant_id = $1 AND action = 'payment_link.created' AND resource_id = $2`,
      [orgA, first.json().id]
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0]).toMatchObject({ actor_type: 'user', auth_method: 'session' });

    // Mismo serializer que el plano de API key.
    const viaApiKey = await app.inject({
      method: 'POST',
      url: '/v1/payment_links',
      headers: { ...apiAuth(keyA), 'idempotency-key': `key-link-${randomUUID()}` },
      payload: { merchant_id: merchantA, amount: 15_000, currency: 'COP' },
    });
    expect(Object.keys(first.json()).sort()).toEqual(Object.keys(viaApiKey.json()).sort());
  });

  it('rejects roles without reconciliation:manage (403) and requires the Idempotency-Key (400)', async () => {
    for (const role of ['analyst', 'read_only', 'support', 'developer']) {
      const user = await sessionUser(role, orgA);
      const res = await app.inject({
        method: 'POST',
        url: `/v1/organizations/${orgA}/payment_links`,
        headers: { ...user.headers, 'idempotency-key': `dash-link-${randomUUID()}` },
        payload: { merchant_id: merchantA, amount: 9_000, currency: 'COP' },
      });
      expect(res.statusCode, role).toBe(403);
    }
    const finance = await sessionUser('finance', orgA);
    const noKey = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgA}/payment_links`,
      headers: finance.headers,
      payload: { merchant_id: merchantA, amount: 9_000, currency: 'COP' },
    });
    expect(noKey.statusCode).toBe(400);
    expect(noKey.json().error.code).toBe('idempotency_key_required');
  });

  it('cannot create a link for a foreign merchant (cross-tenant) nor act on a foreign org', async () => {
    const outsider = await sessionUser('owner', orgB);
    const foreignOrg = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgA}/payment_links`,
      headers: { ...outsider.headers, 'idempotency-key': `dash-link-${randomUUID()}` },
      payload: { merchant_id: merchantA, amount: 9_000, currency: 'COP' },
    });
    expect(foreignOrg.statusCode).toBe(404);
    // Miembro de orgB usando un merchant de orgA: invisible bajo RLS => 4xx sin crear.
    const crossMerchant = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgB}/payment_links`,
      headers: { ...outsider.headers, 'idempotency-key': `dash-link-${randomUUID()}` },
      payload: { merchant_id: merchantA, amount: 9_000, currency: 'COP' },
    });
    expect(crossMerchant.statusCode).toBeGreaterThanOrEqual(400);
    expect(crossMerchant.statusCode).toBeLessThan(500);
    const ownerA = await sessionUser('owner', orgA);
    const list = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgA}/payment_links?limit=100`,
      headers: ownerA.headers,
    });
    const foreign = (list.json().data as Array<{ amount: number }>).filter(
      (l) => l.amount === 9_000
    );
    expect(foreign.length).toBe(0);
  });
});
