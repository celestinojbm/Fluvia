import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@fluvia/config';
import { createPool, type Pool } from '@fluvia/db';
import { AuthService } from '@fluvia/auth';
import { ApiKeyService, IdentityService } from '@fluvia/identity';
import { buildApp } from '../src/app.js';

let app: FastifyInstance;
let appPool: Pool;
let authPool: Pool;
let adminPool: Pool;

const PASSWORD = 'org routes password 55';
const uniqueEmail = () => `orgr-${randomUUID().slice(0, 12)}@example.com`;

/** Registra+verifica+loguea un usuario y opcionalmente lo hace miembro de una org. */
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
  const headers = { authorization: `Bearer ${login.json().session_token as string}` };
  // TM-02: keys:manage exige re-autenticacion fresca tambien SIN MFA. La sesion
  // de esta suite se step-up-ea como haria un operador real antes de gestionar
  // keys; los denies de RBAC/scopes que se prueban abajo siguen intactos.
  await app.inject({
    method: 'POST',
    url: '/v1/auth/step-up/password',
    headers,
    payload: { password: PASSWORD },
  });
  return { userId: user_id as string, headers };
}

async function createOrg(name: string): Promise<string> {
  const res = await adminPool.query<{ id: string }>(
    'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id',
    [name, `org-${randomUUID()}`]
  );
  return res.rows[0]!.id;
}

beforeAll(async () => {
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' });
  appPool = createPool({ connectionString: config.db.app, max: 4 });
  authPool = createPool({ connectionString: config.db.auth, max: 4 });
  adminPool = createPool({ connectionString: config.db.admin, max: 2 });
  app = buildApp({
    config,
    appPool,
    authService: new AuthService(authPool),
    identityService: new IdentityService(appPool),
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

describe('plano de dashboard: sesion + rol (RBAC)', () => {
  it('owner can read the org, create merchants and manage api keys', async () => {
    const orgId = await createOrg('RBAC Owner Org');
    const owner = await sessionUser('owner', orgId);

    const orgs = await app.inject({
      method: 'GET',
      url: '/v1/organizations',
      headers: owner.headers,
    });
    expect(
      orgs
        .json()
        .organizations.some((o: { organization_id: string }) => o.organization_id === orgId)
    ).toBe(true);

    const detail = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}`,
      headers: owner.headers,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().id).toBe(orgId);

    const merchant = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/merchants`,
      headers: owner.headers,
      payload: { name: 'Comercio Owner' },
    });
    expect(merchant.statusCode).toBe(201);
    expect(merchant.json().defaultCurrency).toBe('COP');

    const members = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/members`,
      headers: owner.headers,
    });
    expect(members.statusCode).toBe(200);
    expect(
      members.json().members.some((m: { user_id: string }) => m.user_id === owner.userId)
    ).toBe(true);
  });

  it('BOLA: a member of another org gets 404 (indistinguible de inexistente)', async () => {
    const orgA = await createOrg('BOLA Org A');
    const orgB = await createOrg('BOLA Org B');
    const memberOfB = await sessionUser('owner', orgB);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgA}`,
      headers: memberOfB.headers,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');

    const ghost = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${randomUUID()}`,
      headers: memberOfB.headers,
    });
    expect(ghost.statusCode).toBe(404);
    expect(ghost.json().error.code).toBe('not_found');
  });

  it('RBAC: developer can manage keys but cannot write merchants; read_only cannot read keys', async () => {
    const orgId = await createOrg('RBAC Roles Org');
    const developer = await sessionUser('developer', orgId);
    const readOnly = await sessionUser('read_only', orgId);

    const denied = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/merchants`,
      headers: developer.headers,
      payload: { name: 'No Deberia' },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('insufficient_permissions');

    const key = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/api-keys`,
      headers: developer.headers,
      payload: { label: 'dev key', scopes: ['read'] },
    });
    expect(key.statusCode).toBe(201);

    const keysDenied = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/api-keys`,
      headers: readOnly.headers,
    });
    expect(keysDenied.statusCode).toBe(403);
  });

  it('rejects session-plane routes without a valid session', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/organizations' });
    expect(res.statusCode).toBe(401);
  });

  it('SECURITY (F6): a malformed merchant id is a 400 validation_error, not a 500', async () => {
    const orgId = await createOrg('Malformed Id Org');
    const owner = await sessionUser('owner', orgId);
    const res = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/merchants/not-a-uuid`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
  });
});

describe('plano de integracion: API key + scopes', () => {
  it('full lifecycle: create key -> use on /v1/account -> revoke -> 401', async () => {
    const orgId = await createOrg('Integration Org');
    const owner = await sessionUser('owner', orgId);
    await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/merchants`,
      headers: owner.headers,
      payload: { name: 'Comercio Integrado' },
    });

    const created = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/api-keys`,
      headers: owner.headers,
      payload: { label: 'integration', scopes: ['read'] },
    });
    expect(created.statusCode).toBe(201);
    const { id: keyId, secret } = created.json();
    expect(secret).toMatch(/^fluvia_sk_test_/);

    // El listado jamas re-expone el secreto.
    const listed = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/api-keys`,
      headers: owner.headers,
    });
    expect(JSON.stringify(listed.json())).not.toContain(secret);

    const account = await app.inject({
      method: 'GET',
      url: '/v1/account',
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(account.statusCode).toBe(200);
    const body = account.json();
    expect(body.organization.id).toBe(orgId);
    expect(body.merchants).toHaveLength(1);
    expect(body.environment).toBe('test');

    const revoke = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/api-keys/${keyId}/revoke`,
      headers: owner.headers,
    });
    expect(revoke.statusCode).toBe(204);

    const afterRevoke = await app.inject({
      method: 'GET',
      url: '/v1/account',
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(afterRevoke.statusCode).toBe(401);
    expect(afterRevoke.json().error.code).toBe('invalid_api_key');
  });

  it('enforces scopes: a key without read cannot call /v1/account', async () => {
    const orgId = await createOrg('Scope Org');
    const owner = await sessionUser('owner', orgId);
    const created = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/api-keys`,
      headers: owner.headers,
      payload: { label: 'write-only', scopes: ['payments:write'] },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/account',
      headers: { authorization: `Bearer ${created.json().secret}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('insufficient_scope');
  });

  it('planes no intercambiables: session token on api-key plane and viceversa fail', async () => {
    const orgId = await createOrg('Planes Org');
    const owner = await sessionUser('owner', orgId);
    const sessionToken = owner.headers.authorization;

    const account = await app.inject({
      method: 'GET',
      url: '/v1/account',
      headers: { authorization: sessionToken },
    });
    expect(account.statusCode).toBe(401);
    expect(account.json().error.code).toBe('invalid_api_key');

    const key = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/api-keys`,
      headers: owner.headers,
      payload: { label: 'k', scopes: ['read'] },
    });
    const orgWithKey = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}`,
      headers: { authorization: `Bearer ${key.json().secret}` },
    });
    expect(orgWithKey.statusCode).toBe(401);
    expect(orgWithKey.json().error.code).toBe('invalid_session');
  });

  it('garbage api keys are rejected', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/account',
      headers: { authorization: 'Bearer fluvia_sk_test_deadbeef' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('audit log (F1-05)', () => {
  it('sensitive actions produce audit events with actor and request id, atomically', async () => {
    const orgId = await createOrg('Audit Org');
    const owner = await sessionUser('owner', orgId);

    const created = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/api-keys`,
      headers: owner.headers,
      payload: { label: 'audited-key', scopes: ['read'] },
    });
    const keyId = created.json().id as string;
    await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/api-keys/${keyId}/revoke`,
      headers: owner.headers,
    });
    await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/merchants`,
      headers: owner.headers,
      payload: { name: 'Comercio Auditado' },
    });

    const events = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/audit-events`,
      headers: owner.headers,
    });
    expect(events.statusCode).toBe(200);
    const list = events.json().audit_events as Array<{
      action: string;
      actor_id: string;
      request_id: string | null;
      risk_level: string;
      resource_id: string;
    }>;
    const actions = list.map((e) => e.action);
    expect(actions).toContain('api_key.created');
    expect(actions).toContain('api_key.revoked');
    expect(actions).toContain('merchant.created');
    const keyEvent = list.find((e) => e.action === 'api_key.created')!;
    expect(keyEvent.actor_id).toBe(owner.userId);
    expect(keyEvent.request_id).toBeTruthy();
    expect(keyEvent.risk_level).toBe('high');
    expect(keyEvent.resource_id).toBe(keyId);
    // El audit log jamas contiene el secreto de la key.
    expect(JSON.stringify(list)).not.toContain(created.json().secret);
  });

  it('audit:read is enforced: developer and read_only get 403', async () => {
    const orgId = await createOrg('Audit RBAC Org');
    const developer = await sessionUser('developer', orgId);
    const res = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/audit-events`,
      headers: developer.headers,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('insufficient_permissions');
  });

  it('audit events are tenant-isolated (BOLA on the audit trail)', async () => {
    const orgA = await createOrg('Audit Iso A');
    const orgB = await createOrg('Audit Iso B');
    const ownerA = await sessionUser('owner', orgA);
    const ownerB = await sessionUser('owner', orgB);
    await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgA}/merchants`,
      headers: ownerA.headers,
      payload: { name: 'Solo En A' },
    });
    const eventsB = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgB}/audit-events`,
      headers: ownerB.headers,
    });
    const actionsB = (eventsB.json().audit_events as Array<{ action: string }>).map(
      (e) => e.action
    );
    expect(actionsB).not.toContain('merchant.created');
  });
});
