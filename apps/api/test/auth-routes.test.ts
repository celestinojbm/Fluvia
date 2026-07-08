import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@fluvia/config';
import { createPool, type Pool } from '@fluvia/db';
import { AuthService } from '@fluvia/auth';
import { buildApp } from '../src/app.js';

let app: FastifyInstance;
let appPool: Pool;
let authPool: Pool;

const uniqueEmail = () => `route-${randomUUID().slice(0, 12)}@example.com`;
const PASSWORD = 'route test password 99';

async function registerVerifyLogin() {
  const email = uniqueEmail();
  const reg = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email, password: PASSWORD },
  });
  expect(reg.statusCode).toBe(201);
  const { verification_token, user_id } = reg.json();
  await app.inject({
    method: 'POST',
    url: '/v1/auth/verify-email',
    payload: { token: verification_token },
  });
  const login = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email, password: PASSWORD },
  });
  expect(login.statusCode).toBe(200);
  return { email, userId: user_id as string, sessionToken: login.json().session_token as string };
}

beforeAll(async () => {
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' });
  appPool = createPool({ connectionString: config.db.app, max: 2 });
  authPool = createPool({ connectionString: config.db.auth, max: 4 });
  // Limites generosos: esta suite dispara muchos requests desde la MISMA IP
  // de inject; los limites reales se prueban en mfa-routes.test.ts.
  app = buildApp({
    config,
    appPool,
    authService: new AuthService(authPool),
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
  await Promise.all([appPool.end(), authPool.end()]);
});

describe('POST /v1/auth/register', () => {
  it('creates the user and exposes the verification token ONLY because env=test', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: uniqueEmail(), password: PASSWORD },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.user_id).toBeTruthy();
    expect(body.verification_token).toMatch(/^fluvia_verify_/);
  });

  it('maps duplicate email to 409 email_taken', async () => {
    const email = uniqueEmail();
    await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email, password: PASSWORD },
    });
    const dup = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email, password: PASSWORD },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('email_taken');
  });

  it('returns 400 validation_error with details on malformed/extra fields', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'nope', password: 'short', isAdmin: true },
    });
    expect(bad.statusCode).toBe(400);
    const body = bad.json();
    expect(body.error.code).toBe('validation_error');
    expect(Array.isArray(body.error.details)).toBe(true);
    expect(body.error.request_id).toBeTruthy();
  });
});

describe('login y sesion', () => {
  it('full flow: register -> verify -> login -> session -> logout', async () => {
    const { userId, sessionToken } = await registerVerifyLogin();

    const session = await app.inject({
      method: 'GET',
      url: '/v1/auth/session',
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(session.statusCode).toBe(200);
    expect(session.json().user_id).toBe(userId);
    expect(session.json().memberships).toEqual([]);

    const logout = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(logout.statusCode).toBe(204);

    const after = await app.inject({
      method: 'GET',
      url: '/v1/auth/session',
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(after.statusCode).toBe(401);
    expect(after.json().error.code).toBe('invalid_session');
  });

  it('logout-all revokes EVERY session of the user, including the caller (F6)', async () => {
    const { email, sessionToken: s1 } = await registerVerifyLogin();
    // Segunda sesión del MISMO usuario (otro dispositivo).
    const login2 = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password: PASSWORD },
    });
    const s2 = login2.json().session_token as string;

    const alive = (t: string) =>
      app
        .inject({
          method: 'GET',
          url: '/v1/auth/session',
          headers: { authorization: `Bearer ${t}` },
        })
        .then((r) => r.statusCode);
    expect(await alive(s1)).toBe(200);
    expect(await alive(s2)).toBe(200);

    const all = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout-all',
      headers: { authorization: `Bearer ${s1}` },
    });
    expect(all.statusCode).toBe(200);
    expect(all.json().revoked_sessions).toBeGreaterThanOrEqual(2);

    // Ambas quedan inválidas — incluida la que ejecutó la revocación.
    expect(await alive(s1)).toBe(401);
    expect(await alive(s2)).toBe(401);
  });

  it('logout-all requires a valid session', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout-all',
      headers: { authorization: 'Bearer fluvia_sess_garbage' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('invalid_session');
  });

  it('maps wrong credentials to 401 invalid_credentials (uniform)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: uniqueEmail(), password: 'whatever password 1' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('invalid_credentials');
  });

  it('maps unverified email to 403 email_not_verified', async () => {
    const email = uniqueEmail();
    await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email, password: PASSWORD },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('email_not_verified');
  });

  it('session endpoint without bearer returns 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/auth/session' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('invalid_session');
  });
});
