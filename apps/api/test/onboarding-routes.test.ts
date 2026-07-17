import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@fluvia/config';
import { createPool, type Pool } from '@fluvia/db';
import { AuthService } from '@fluvia/auth';
import { ApiKeyService, IdentityService } from '@fluvia/identity';
import { buildApp } from '../src/app.js';

/**
 * F6.5C2 — rutas de onboarding sobre HTTP real (inject) y PostgreSQL real:
 *
 *  - `POST /v1/organizations` (Paso A): sesion-only, replay natural, 409
 *    estables, rechazo de API key/no autenticado/no verificado.
 *  - `POST /v1/organizations/:orgId/onboarding/merchant` (Paso B): RBAC
 *    `merchants:write`, cardinalidad 1, chart idempotente, recuperacion tras
 *    fallo entre merchant y chart, aislamiento cross-tenant (404).
 */

let app: FastifyInstance;
let appPool: Pool;
let authPool: Pool;
let adminPool: Pool;
let identityService: IdentityService;

const PASSWORD = 'onboarding routes pw 77';
const uniqueEmail = () => `onbr-${randomUUID().slice(0, 12)}@example.com`;
const uniqueSlug = () => `onbr-${randomUUID().slice(0, 12)}`;

/** Registra+verifica+loguea un usuario; opcionalmente con membership previa. */
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
    await adminPool.query('INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1,$2,$3)', [
      orgId,
      user_id,
      role,
    ]);
  }
  const login = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email, password: PASSWORD },
  });
  return {
    userId: user_id as string,
    headers: { authorization: `Bearer ${login.json().session_token as string}` },
  };
}

async function auditCount(tenantId: string, action: string): Promise<number> {
  const res = await adminPool.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM audit_events WHERE tenant_id = $1 AND action = $2',
    [tenantId, action]
  );
  return Number(res.rows[0]!.n);
}

async function chartAccountCount(tenantId: string): Promise<number> {
  const res = await adminPool.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM ledger_accounts WHERE tenant_id = $1',
    [tenantId]
  );
  return Number(res.rows[0]!.n);
}

beforeAll(async () => {
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' });
  appPool = createPool({ connectionString: config.db.app, max: 6 });
  authPool = createPool({ connectionString: config.db.auth, max: 4 });
  adminPool = createPool({ connectionString: config.db.admin, max: 4 });
  identityService = new IdentityService(appPool);
  app = buildApp({
    config,
    appPool,
    adminPool,
    authService: new AuthService(authPool),
    identityService,
    apiKeyService: new ApiKeyService(appPool),
    authRateLimits: {
      loginPerEmail: { max: 10_000, windowMs: 60_000 },
      loginPerIp: { max: 10_000, windowMs: 60_000 },
      registerPerIp: { max: 10_000, windowMs: 60_000 },
      mfaPerIp: { max: 10_000, windowMs: 60_000 },
    },
  });
  await app.ready();
}, 30_000);

afterAll(async () => {
  await app.close();
  await Promise.all([appPool.end(), authPool.end(), adminPool.end()]);
});

describe('POST /v1/organizations (Paso A, plano de plataforma)', () => {
  it('201: creates the org with owner membership; the org appears in GET /v1/organizations', async () => {
    const user = await sessionUser();
    const slug = uniqueSlug();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: user.headers,
      payload: { organizationName: 'Mi Empresa', slug },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.organization.name).toBe('Mi Empresa');
    expect(body.organization.slug).toBe(slug);
    expect(body.membership).toEqual({ role: 'owner' });
    expect(body.replayed).toBe(false);

    const orgs = await app.inject({
      method: 'GET',
      url: '/v1/organizations',
      headers: user.headers,
    });
    const mine = orgs
      .json()
      .organizations.find(
        (o: { organization_id: string }) => o.organization_id === body.organization.id
      );
    expect(mine).toBeTruthy();
    expect(mine.role).toBe('owner');
    expect(await auditCount(body.organization.id, 'organization.created')).toBe(1);
    expect(await auditCount(body.organization.id, 'membership.created')).toBe(1);
  });

  it('retry with the same payload => 200 replayed:true, same org, zero duplicate audits', async () => {
    const user = await sessionUser();
    const payload = { organizationName: 'Replay HTTP SA', slug: uniqueSlug() };
    const first = await app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: user.headers,
      payload,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: user.headers,
      payload,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().replayed).toBe(true);
    expect(second.json().organization.id).toBe(first.json().organization.id);
    expect(await auditCount(first.json().organization.id, 'organization.created')).toBe(1);
    expect(await auditCount(first.json().organization.id, 'membership.created')).toBe(1);
  });

  it('a different payload after onboarding => 409 onboarding_already_completed', async () => {
    const user = await sessionUser();
    await app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: user.headers,
      payload: { organizationName: 'Original SA', slug: uniqueSlug() },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: user.headers,
      payload: { organizationName: 'Cambiada SA', slug: uniqueSlug() },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('onboarding_already_completed');
  });

  it("someone else's slug => 409 organization_slug_taken without leaking foreign data", async () => {
    const slug = uniqueSlug();
    const owner = await sessionUser();
    await app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: owner.headers,
      payload: { organizationName: 'Dueña Original', slug },
    });
    const intruder = await sessionUser();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: intruder.headers,
      payload: { organizationName: 'Aspirante', slug },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('organization_slug_taken');
    expect(res.body).not.toContain('Dueña Original');
  });

  it('validation: bad slug / extra fields => 400 validation_error', async () => {
    const user = await sessionUser();
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: user.headers,
      payload: { organizationName: 'Valida SA', slug: 'Bad_Slug!', admin: true },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('validation_error');
  });

  it('unauthenticated => 401; API key => 401 (los planos no se cruzan)', async () => {
    const anon = await app.inject({
      method: 'POST',
      url: '/v1/organizations',
      payload: { organizationName: 'Anonima', slug: uniqueSlug() },
    });
    expect(anon.statusCode).toBe(401);

    const owner = await sessionUser();
    const orgRes = await app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: owner.headers,
      payload: { organizationName: 'Con Key SA', slug: uniqueSlug() },
    });
    const orgId = orgRes.json().organization.id as string;
    const key = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/api-keys`,
      headers: owner.headers,
      payload: { label: 'k', scopes: ['read'] },
    });
    // keys:manage exige step-up: refrescamos y reintentamos si hizo falta.
    let secret = key.json().secret as string | undefined;
    if (!secret) {
      await app.inject({
        method: 'POST',
        url: '/v1/auth/step-up/password',
        headers: owner.headers,
        payload: { password: PASSWORD },
      });
      const retry = await app.inject({
        method: 'POST',
        url: `/v1/organizations/${orgId}/api-keys`,
        headers: owner.headers,
        payload: { label: 'k', scopes: ['read'] },
      });
      secret = retry.json().secret as string;
    }
    const withKey = await app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: { authorization: `Bearer ${secret}` },
      payload: { organizationName: 'Via Key', slug: uniqueSlug() },
    });
    expect(withKey.statusCode).toBe(401);
    expect(withKey.json().error.code).toBe('invalid_session');
  });

  it('unverified user => 403 email_not_verified with zero writes (defensa en profundidad)', async () => {
    const user = await sessionUser();
    // La sesion existe (login exigio verificacion); se des-verifica después
    // para probar el re-chequeo DENTRO de la transaccion del servicio.
    await adminPool.query('UPDATE users SET email_verified_at = NULL WHERE id = $1', [user.userId]);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: user.headers,
      payload: { organizationName: 'No Verificada', slug: uniqueSlug() },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('email_not_verified');
    const owned = await adminPool.query('SELECT 1 FROM memberships WHERE user_id = $1', [
      user.userId,
    ]);
    expect(owned.rowCount).toBe(0);
  });
});

describe('POST /v1/organizations/:orgId/onboarding/merchant (Paso B, plano tenant)', () => {
  async function ownerWithOrg() {
    const user = await sessionUser();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: user.headers,
      payload: { organizationName: 'Org Merchant', slug: uniqueSlug() },
    });
    return { ...user, orgId: res.json().organization.id as string };
  }

  it('201: one merchant, merchant.created once, chart ready', async () => {
    const owner = await ownerWithOrg();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${owner.orgId}/onboarding/merchant`,
      headers: owner.headers,
      payload: { name: 'Tienda Uno', country: 'CO', defaultCurrency: 'COP' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.merchant.name).toBe('Tienda Uno');
    expect(body.merchant.country).toBe('CO');
    expect(body.merchant.defaultCurrency).toBe('COP');
    expect(body.chartReady).toBe(true);
    expect(body.replayed).toBe(false);
    expect(await auditCount(owner.orgId, 'merchant.created')).toBe(1);
    // Chart materializado (cuentas platform + merchant scope del catalogo).
    expect(await chartAccountCount(owner.orgId)).toBeGreaterThan(0);
  });

  it('identical retry => 200 replayed:true, chart no-op, zero duplicate audit/merchant', async () => {
    const owner = await ownerWithOrg();
    const payload = { name: 'Tienda Retry', country: 'CO', defaultCurrency: 'COP' };
    const first = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${owner.orgId}/onboarding/merchant`,
      headers: owner.headers,
      payload,
    });
    const accountsAfterFirst = await chartAccountCount(owner.orgId);
    const second = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${owner.orgId}/onboarding/merchant`,
      headers: owner.headers,
      payload,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().replayed).toBe(true);
    expect(second.json().merchant.id).toBe(first.json().merchant.id);
    expect(second.json().chartReady).toBe(true);
    expect(await auditCount(owner.orgId, 'merchant.created')).toBe(1);
    // ensureChart idempotente: cero cuentas nuevas en el retry.
    expect(await chartAccountCount(owner.orgId)).toBe(accountsAfterFirst);
  });

  it('recovery: merchant created but chart step never ran => the retry completes the chart without duplicating', async () => {
    const owner = await ownerWithOrg();
    // Simula el fallo DESPUES del merchant y ANTES del chart: el merchant se
    // crea por el servicio (commit) y el chart no se ejecuta.
    await identityService.ensureMerchantForOnboarding(
      owner.orgId,
      { name: 'Tienda Recuperada', country: 'CO', defaultCurrency: 'COP' },
      { actorType: 'user', actorId: owner.userId, authMethod: 'session' }
    );
    expect(await chartAccountCount(owner.orgId)).toBe(0);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${owner.orgId}/onboarding/merchant`,
      headers: owner.headers,
      payload: { name: 'Tienda Recuperada', country: 'CO', defaultCurrency: 'COP' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().replayed).toBe(true);
    expect(res.json().chartReady).toBe(true);
    const merchants = await adminPool.query(
      'SELECT 1 FROM merchants WHERE tenant_id = $1 AND deleted_at IS NULL',
      [owner.orgId]
    );
    expect(merchants.rowCount).toBe(1);
    expect(await auditCount(owner.orgId, 'merchant.created')).toBe(1);
    expect(await chartAccountCount(owner.orgId)).toBeGreaterThan(0);
  });

  it('a different payload => 409 merchant_onboarding_already_completed', async () => {
    const owner = await ownerWithOrg();
    await app.inject({
      method: 'POST',
      url: `/v1/organizations/${owner.orgId}/onboarding/merchant`,
      headers: owner.headers,
      payload: { name: 'Tienda Fija' },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${owner.orgId}/onboarding/merchant`,
      headers: owner.headers,
      payload: { name: 'Tienda Cambiada' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('merchant_onboarding_already_completed');
  });

  it('two preexisting merchants => stable 409 (no arbitrary selection)', async () => {
    const owner = await ownerWithOrg();
    await app.inject({
      method: 'POST',
      url: `/v1/organizations/${owner.orgId}/merchants`,
      headers: owner.headers,
      payload: { name: 'General Uno' },
    });
    await app.inject({
      method: 'POST',
      url: `/v1/organizations/${owner.orgId}/merchants`,
      headers: owner.headers,
      payload: { name: 'General Dos' },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${owner.orgId}/onboarding/merchant`,
      headers: owner.headers,
      payload: { name: 'General Uno' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('merchant_onboarding_already_completed');
  });

  it('cross-tenant => 404 indistinguible de inexistente', async () => {
    const ownerA = await ownerWithOrg();
    const ownerB = await ownerWithOrg();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${ownerA.orgId}/onboarding/merchant`,
      headers: ownerB.headers,
      payload: { name: 'Intrusa' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
    const ghost = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${randomUUID()}/onboarding/merchant`,
      headers: ownerB.headers,
      payload: { name: 'Fantasma' },
    });
    expect(ghost.statusCode).toBe(404);
    expect(ghost.json().error.code).toBe('not_found');
  });

  it('insufficient permissions (rol sin merchants:write) => 403; API key => 401', async () => {
    const owner = await ownerWithOrg();
    const support = await sessionUser('support', owner.orgId);
    const denied = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${owner.orgId}/onboarding/merchant`,
      headers: support.headers,
      payload: { name: 'Sin Permiso' },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('insufficient_permissions');

    const withKey = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${owner.orgId}/onboarding/merchant`,
      headers: { authorization: 'Bearer fluvia_sk_test_deadbeef' },
      payload: { name: 'Via Key' },
    });
    expect(withKey.statusCode).toBe(401);
    expect(withKey.json().error.code).toBe('invalid_session');
  });

  it('validation: invalid currency/extra fields => 400 validation_error', async () => {
    const owner = await ownerWithOrg();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${owner.orgId}/onboarding/merchant`,
      headers: owner.headers,
      payload: { name: 'Mala Moneda', defaultCurrency: 'XXX' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
  });
});
