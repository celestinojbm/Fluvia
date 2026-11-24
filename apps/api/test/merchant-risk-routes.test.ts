import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@fluvia/config';
import { createPool, type Pool } from '@fluvia/db';
import { AuthService } from '@fluvia/auth';
import { ApiKeyService, IdentityService, MerchantRiskAdmin } from '@fluvia/identity';
import { buildApp } from '../src/app.js';

/**
 * #92 visto desde HTTP:
 *  - alta de comercio: la declaración de afiliación estatal es obligatoria;
 *    `government`/`state_owned` o un nombre en la lista => `403
 *    merchant_onboarding_blocked`, sin decir cuál de las dos ni el patrón;
 *  - comercio congelado: el guard del motor (0069) llega como `403
 *    merchant_frozen` con el sobre del catálogo, sin filas a medias y SIN quemar
 *    la Idempotency-Key (tras descongelar, el mismo request se procesa).
 */

let app: FastifyInstance;
let appPool: Pool;
let authPool: Pool;
let adminPool: Pool;
let risk: MerchantRiskAdmin;
let apiKeys: ApiKeyService;
const operator = randomUUID();
const FREEZE_REASON = 'motivo-confidencial-sanciones';
const PASSWORD = 'merchant risk password 92';

beforeAll(async () => {
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' });
  appPool = createPool({ connectionString: config.db.app, max: 4 });
  authPool = createPool({ connectionString: config.db.auth, max: 2 });
  adminPool = createPool({ connectionString: config.db.admin, max: 2 });
  apiKeys = new ApiKeyService(appPool);
  app = buildApp({
    config,
    appPool,
    authService: new AuthService(authPool),
    identityService: new IdentityService(appPool),
    apiKeyService: apiKeys,
    authRateLimits: {
      loginPerEmail: { max: 10_000, windowMs: 60_000 },
      loginPerIp: { max: 10_000, windowMs: 60_000 },
      registerPerIp: { max: 10_000, windowMs: 60_000 },
      mfaPerIp: { max: 10_000, windowMs: 60_000 },
    },
  });
  await app.ready();
  risk = new MerchantRiskAdmin(adminPool);
}, 30_000);

afterAll(async () => {
  await app.close();
  await Promise.all([appPool.end(), authPool.end(), adminPool.end()]);
});

async function createOrg(): Promise<string> {
  const res = await adminPool.query<{ id: string }>(
    'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id',
    [`Risk Org ${randomUUID().slice(0, 6)}`, `org-${randomUUID()}`]
  );
  return res.rows[0]!.id;
}

/** Owner con sesión verificada en `orgId`. */
async function ownerSession(orgId: string): Promise<Record<string, string>> {
  const email = `risk-${randomUUID().slice(0, 12)}@example.com`;
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
  await adminPool.query(
    `INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [orgId, user_id]
  );
  const login = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email, password: PASSWORD },
  });
  return { authorization: `Bearer ${login.json().session_token as string}` };
}

describe('alta de comercio sobre HTTP (#92)', () => {
  it('sin declaración => 400 validation_error con el campo señalado', async () => {
    const orgId = await createOrg();
    const headers = await ownerSession(orgId);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/merchants`,
      headers,
      payload: { name: `Sin Declarar ${randomUUID().slice(0, 6)}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
    expect(JSON.stringify(res.json().error.details)).toContain('stateAffiliation');
  });

  it.each([
    ['merchants', { stateAffiliation: 'government' }],
    ['merchants', { stateAffiliation: 'state_owned' }],
    ['merchants', { stateAffiliation: 'none', name: 'PDVSA Gas' }],
    ['onboarding/merchant', { stateAffiliation: 'state_owned' }],
    ['onboarding/merchant', { stateAffiliation: 'none', name: 'Petróleos de Venezuela' }],
  ] as const)(
    'POST /%s %j => 403 merchant_onboarding_blocked sin pistas y sin filas',
    async (path, extra) => {
      const orgId = await createOrg();
      const headers = await ownerSession(orgId);
      const res = await app.inject({
        method: 'POST',
        url: `/v1/organizations/${orgId}/${path}`,
        headers,
        payload: { name: `Comercio ${randomUUID().slice(0, 6)}`, ...extra },
      });
      expect(res.statusCode).toBe(403);
      const body = res.json();
      expect(body.error).toMatchObject({
        code: 'merchant_onboarding_blocked',
        type: 'authorization_error',
        message: 'This merchant cannot be onboarded at this time',
      });
      // Ni el patrón de la lista ni la causa concreta llegan al cliente.
      expect(res.body.toLowerCase()).not.toMatch(/pdvsa|denylist|state_owned|government|fv452/);
      const rows = await adminPool.query('SELECT 1 FROM merchants WHERE tenant_id = $1', [orgId]);
      expect(rows.rowCount).toBe(0);
    }
  );

  it('none => 201 y la declaración se devuelve en el recurso', async () => {
    const orgId = await createOrg();
    const headers = await ownerSession(orgId);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/merchants`,
      headers,
      payload: { name: `Privada ${randomUUID().slice(0, 6)}`, stateAffiliation: 'none' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().stateAffiliation).toBe('none');
  });
});

describe('comercio congelado sobre HTTP (#92)', () => {
  async function frozenSetup() {
    const org = await createOrg();
    const m = await adminPool.query<{ id: string }>(
      `INSERT INTO merchants (tenant_id, name, state_affiliation) VALUES ($1, $2, 'none') RETURNING id`,
      [org, `fz-http-${randomUUID().slice(0, 8)}`]
    );
    const key = (await apiKeys.create(org, { label: 'fz', scopes: ['read', 'payments:write'] }))
      .secret;
    const merchant = m.rows[0]!.id;
    const post = (url: string, idem: string, payload: Record<string, unknown>) =>
      app.inject({
        method: 'POST',
        url,
        headers: { authorization: `Bearer ${key}`, 'idempotency-key': idem },
        payload,
      });
    const intentBody = { merchant_id: merchant, amount: 25_000, currency: 'COP' };
    return { org, merchant, post, intentBody };
  }

  it('POST /v1/payment_intents => 403 merchant_frozen; la key no se quema', async () => {
    const { merchant, post, intentBody } = await frozenSetup();
    await risk.freeze({ merchantId: merchant, reason: FREEZE_REASON, actorId: operator });
    const idem = `fz-create-${randomUUID()}`;

    const blocked = await post('/v1/payment_intents', idem, intentBody);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error).toMatchObject({
      code: 'merchant_frozen',
      type: 'authorization_error',
    });
    expect(blocked.body).not.toContain(FREEZE_REASON);
    const rows = await adminPool.query(`SELECT 1 FROM payment_intents WHERE merchant_id = $1`, [
      merchant,
    ]);
    expect(rows.rowCount).toBe(0);

    await risk.unfreeze({ merchantId: merchant, reason: 'revisado', actorId: operator });
    const ok = await post('/v1/payment_intents', idem, intentBody);
    expect(ok.statusCode).toBe(201);
    expect(ok.headers['idempotency-replayed']).toBe('false');
  });

  it('POST /v1/payment_intents/:id/confirm => 403 y el intent queda en created', async () => {
    const { merchant, post, intentBody } = await frozenSetup();
    const created = await post('/v1/payment_intents', `fz-pre-${randomUUID()}`, intentBody);
    expect(created.statusCode).toBe(201);
    const intentId = created.json().id as string;

    await risk.freeze({ merchantId: merchant, reason: FREEZE_REASON, actorId: operator });
    const blocked = await post(`/v1/payment_intents/${intentId}/confirm`, `fz-c-${randomUUID()}`, {
      payment_method_token: 'tok_approve',
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('merchant_frozen');
    const st = await adminPool.query<{ status: string }>(
      `SELECT status FROM payment_intents WHERE id = $1`,
      [intentId]
    );
    expect(st.rows[0]!.status).toBe('created');
  });
});
