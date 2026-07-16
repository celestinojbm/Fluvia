import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig, type AppConfig } from '@fluvia/config';
import { createPool, type Pool } from '@fluvia/db';
import { AuthService } from '@fluvia/auth';
import { buildApp } from '../src/app.js';

/**
 * F6.5C1 (B6) — `POST /v1/auth/register-sandbox` sobre HTTP real (inject) y
 * PostgreSQL real. Gating por entorno: presente en local/test; AUSENTE (404,
 * nunca 500, nunca fallback a register) en sandbox/staging/production.
 * Respuesta minima sin token de verificacion, sin session token y sin cookie.
 * Rate limit: comparte la MISMA clave `register:ip` (5/60s default) que
 * `/v1/auth/register`.
 */

let config: AppConfig;
let app: FastifyInstance;
let appPool: Pool;
let authPool: Pool;

const uniqueEmail = () => `sbxroute-${randomUUID().slice(0, 12)}@example.com`;
const PASSWORD = 'route sandbox password 1';
const GENEROUS = {
  loginPerEmail: { max: 10_000, windowMs: 60_000 },
  loginPerIp: { max: 10_000, windowMs: 60_000 },
  registerPerIp: { max: 10_000, windowMs: 60_000 },
  mfaPerIp: { max: 10_000, windowMs: 60_000 },
};

beforeAll(async () => {
  config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' });
  appPool = createPool({ connectionString: config.db.app, max: 2 });
  authPool = createPool({ connectionString: config.db.auth, max: 4 });
  app = buildApp({
    config,
    appPool,
    authService: new AuthService(authPool, { allowSandboxRegistration: true }),
    authRateLimits: GENEROUS,
  });
  await app.ready();
}, 30_000);

afterAll(async () => {
  await app.close();
  await Promise.all([appPool.end(), authPool.end()]);
});

describe('en entorno test: presente y con respuesta minima', () => {
  it('201 with the minimal body: no verification_token, no session_token, no Set-Cookie', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register-sandbox',
      payload: { email: uniqueEmail(), password: PASSWORD },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ registered: true, email_verified: true });
    expect(res.body).not.toContain('fluvia_verify');
    expect(res.body).not.toContain('fluvia_sess');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('does NOT log in: the user must still POST /v1/auth/login (and can, because email is verified)', async () => {
    const email = uniqueEmail();
    const reg = await app.inject({
      method: 'POST',
      url: '/v1/auth/register-sandbox',
      payload: { email, password: PASSWORD },
    });
    expect(reg.statusCode).toBe(201);
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password: PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().mfa_required).toBe(false);
  });

  it('maps duplicate email to 409 email_taken (same catalog error as register)', async () => {
    const email = uniqueEmail();
    await app.inject({
      method: 'POST',
      url: '/v1/auth/register-sandbox',
      payload: { email, password: PASSWORD },
    });
    const dup = await app.inject({
      method: 'POST',
      url: '/v1/auth/register-sandbox',
      payload: { email, password: PASSWORD },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('email_taken');
  });

  it('validates with RegisterSchema: 400 validation_error on malformed/extra fields', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/auth/register-sandbox',
      payload: { email: 'nope', password: 'short', admin: true },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('validation_error');
  });

  it('register y verify-email tradicionales conservan su contrato en el mismo app', async () => {
    const email = uniqueEmail();
    const reg = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email, password: PASSWORD },
    });
    expect(reg.statusCode).toBe(201);
    const body = reg.json();
    expect(body.email_verification).toBe('pending');
    expect(body.verification_token).toMatch(/^fluvia_verify_/);
    const verify = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: { token: body.verification_token },
    });
    expect(verify.statusCode).toBe(200);
    expect(verify.json()).toEqual({ verified: true });
  });
});

describe('rate limit compartido con register (misma clave register:ip)', () => {
  it('throttles at the registerPerIp rule: 429 rate_limited shared across both endpoints', async () => {
    const tight = buildApp({
      config,
      appPool,
      authService: new AuthService(authPool, { allowSandboxRegistration: true }),
      authRateLimits: { ...GENEROUS, registerPerIp: { max: 2, windowMs: 60_000 } },
    });
    await tight.ready();
    try {
      // 1 register normal + 1 register-sandbox consumen el MISMO cupo por IP.
      const first = await tight.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: { email: uniqueEmail(), password: PASSWORD },
      });
      expect(first.statusCode).toBe(201);
      const second = await tight.inject({
        method: 'POST',
        url: '/v1/auth/register-sandbox',
        payload: { email: uniqueEmail(), password: PASSWORD },
      });
      expect(second.statusCode).toBe(201);
      const limited = await tight.inject({
        method: 'POST',
        url: '/v1/auth/register-sandbox',
        payload: { email: uniqueEmail(), password: PASSWORD },
      });
      expect(limited.statusCode).toBe(429);
      expect(limited.json().error.code).toBe('rate_limited');
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    } finally {
      await tight.close();
    }
  });
});

describe('fuera de local/test: la ruta NO existe (fail-closed, nunca 500, nunca fallback)', () => {
  for (const env of ['sandbox', 'staging', 'production'] as const) {
    it(`env=${env}: /v1/auth/register-sandbox responds 404 not_found and writes nothing`, async () => {
      const gated = buildApp({
        config: { ...config, env },
        appPool,
        // Espejo del wiring real (server.ts): fuera de local/test la capacidad
        // del servicio tambien queda deshabilitada.
        authService: new AuthService(authPool, { allowSandboxRegistration: false }),
        authRateLimits: GENEROUS,
      });
      await gated.ready();
      try {
        const email = uniqueEmail();
        const res = await gated.inject({
          method: 'POST',
          url: '/v1/auth/register-sandbox',
          payload: { email, password: PASSWORD },
        });
        expect(res.statusCode).toBe(404);
        expect(res.json().error.code).toBe('not_found');
        // Cero escritura: no degrado a register (no existe el usuario).
        const rows = await authPool.query('SELECT id FROM users WHERE lower(email) = $1', [
          email.toLowerCase(),
        ]);
        expect(rows.rowCount).toBe(0);
      } finally {
        await gated.close();
      }
    });
  }

  it('defensa en profundidad: ruta registrada (env test) pero servicio deshabilitado => 404, no 500', async () => {
    const miswired = buildApp({
      config,
      appPool,
      authService: new AuthService(authPool), // sin allowSandboxRegistration
      authRateLimits: GENEROUS,
    });
    await miswired.ready();
    try {
      const email = uniqueEmail();
      const res = await miswired.inject({
        method: 'POST',
        url: '/v1/auth/register-sandbox',
        payload: { email, password: PASSWORD },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('not_found');
      const rows = await authPool.query('SELECT id FROM users WHERE lower(email) = $1', [
        email.toLowerCase(),
      ]);
      expect(rows.rowCount).toBe(0);
    } finally {
      await miswired.close();
    }
  });

  it('env local: la ruta SI existe', async () => {
    const local = buildApp({
      config: { ...config, env: 'local' },
      appPool,
      authService: new AuthService(authPool, { allowSandboxRegistration: true }),
      authRateLimits: GENEROUS,
    });
    await local.ready();
    try {
      const res = await local.inject({
        method: 'POST',
        url: '/v1/auth/register-sandbox',
        payload: { email: uniqueEmail(), password: PASSWORD },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ registered: true, email_verified: true });
    } finally {
      await local.close();
    }
  });
});
