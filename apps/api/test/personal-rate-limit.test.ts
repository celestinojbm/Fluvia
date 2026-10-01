import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@fluvia/config';
import { createPool, type Pool } from '@fluvia/db';
import { AuthService } from '@fluvia/auth';
import { ApiKeyService, IdentityService } from '@fluvia/identity';
import { createPersonalServices } from '@fluvia/personal';
import { buildApp } from '../src/app.js';

/** Login y registro del CLIENTE con límite de tasa (mismo backend que /v1/auth/*). */
let app: FastifyInstance;
let appPool: Pool;
let authPool: Pool;
let adminPool: Pool;
let program: string;

beforeAll(async () => {
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' });
  appPool = createPool({ connectionString: config.db.app, max: 4 });
  authPool = createPool({ connectionString: config.db.auth, max: 2 });
  adminPool = createPool({ connectionString: config.db.admin, max: 2 });
  const org = await adminPool.query<{ id: string }>(
    'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id',
    ['Programa RL', `org-${randomUUID()}`]
  );
  program = org.rows[0]!.id;
  await createPersonalServices({ app: appPool, auth: authPool }).programs.setupProgram(
    program,
    { name: 'Programa', currencies: ['VES'] },
    { kind: 'system' }
  );
  app = buildApp({
    config,
    appPool,
    authPool,
    authService: new AuthService(authPool),
    identityService: new IdentityService(appPool),
    apiKeyService: new ApiKeyService(appPool),
    authRateLimits: {
      loginPerEmail: { max: 3, windowMs: 60_000 },
      loginPerIp: { max: 100, windowMs: 60_000 },
      registerPerIp: { max: 2, windowMs: 60_000 },
      mfaPerIp: { max: 100, windowMs: 60_000 },
    },
  });
  await app.ready();
}, 30_000);

afterAll(async () => {
  await app.close();
  await Promise.all([appPool.end(), authPool.end(), adminPool.end()]);
});

describe('límite de tasa del plano del cliente', () => {
  it('registro por IP y login por correo devuelven 429 al superar la ventana', async () => {
    const reg = () =>
      app.inject({
        method: 'POST',
        url: `/v1/personal/programs/${program}/register`,
        payload: {
          email: `rl-${randomUUID().slice(0, 8)}@x.test`,
          password: 'clave larga de prueba',
          display_name: 'X',
        },
      });
    expect((await reg()).statusCode).toBe(201);
    expect((await reg()).statusCode).toBe(201);
    expect((await reg()).statusCode).toBe(429);
    const login = () =>
      app.inject({
        method: 'POST',
        url: `/v1/personal/programs/${program}/login`,
        payload: { email: 'nadie@x.test', password: 'incorrecta' },
      });
    for (let i = 0; i < 3; i++) expect((await login()).statusCode).toBe(401);
    expect((await login()).statusCode).toBe(429);
  });
});
