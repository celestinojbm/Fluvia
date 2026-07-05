import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@fluvia/config';
import { createPool, type Pool } from '@fluvia/db';
import { AuthService } from '@fluvia/auth';
import { ApiKeyService, IdentityService } from '@fluvia/identity';
import { buildApp } from '../src/app.js';

/**
 * F3-02 — contrato OpenAPI: cada (path, method) declarado en
 * docs/api/openapi.v1.json debe EXISTIR en el servidor y exigir
 * autenticación. La prueba distingue ruta-existente-protegida (401 del
 * catálogo) de ruta inexistente (404 not_found del catch-all): si alguien
 * borra o renombra un endpoint sin tocar el spec, este test revienta.
 */

const SPEC_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'docs',
  'api',
  'openapi.v1.json'
);

interface Spec {
  paths: Record<string, Record<string, unknown>>;
}

let app: FastifyInstance;
let appPool: Pool;
let authPool: Pool;

beforeAll(async () => {
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' });
  appPool = createPool({ connectionString: config.db.app, max: 2 });
  authPool = createPool({ connectionString: config.db.auth, max: 2 });
  app = buildApp({
    config,
    appPool,
    authService: new AuthService(authPool),
    identityService: new IdentityService(appPool),
    apiKeyService: new ApiKeyService(appPool),
  });
  await app.ready();
}, 30_000);

afterAll(async () => {
  await app.close();
  await Promise.all([appPool.end(), authPool.end()]);
});

describe('OpenAPI v1 (parcial) ↔ servidor', () => {
  const spec = JSON.parse(readFileSync(SPEC_PATH, 'utf8')) as Spec;
  const entries = Object.entries(spec.paths).flatMap(([path, methods]) =>
    Object.keys(methods).map((method) => ({ path, method: method.toUpperCase() }))
  );

  it('declares at least the payment_intents surface', () => {
    expect(entries.length).toBeGreaterThanOrEqual(4);
  });

  for (const { path, method } of entries) {
    it(`${method} ${path} exists and demands authentication`, async () => {
      const url = path.replace(/\{id\}/g, randomUUID());
      const res = await app.inject({ method: method as 'GET' | 'POST', url });
      // 401 del plano de API key = la ruta existe y está protegida.
      // (Una ruta inexistente daría el 404 not_found del catch-all.)
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('invalid_api_key');
    });
  }

  it('control: an undeclared path hits the catch-all 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/definitely_not_a_route' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
  });
});
