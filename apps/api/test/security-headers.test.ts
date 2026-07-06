import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@fluvia/config';
import { createPool, type Pool } from '@fluvia/db';
import { buildApp } from '../src/app.js';

/**
 * F3-11a (AUD-P2-016) — cabeceras de seguridad en toda respuesta + CORS de
 * allowlist explícita. El plano solo necesita el pool app (health/hooks
 * globales), así que estos tests no montan los servicios de negocio.
 */

let appPool: Pool;
let defaultApp: FastifyInstance; // sin CORS configurado
let corsApp: FastifyInstance; // con un origen permitido

const ALLOWED = 'https://app.example';

beforeAll(async () => {
  const base = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' });
  appPool = createPool({ connectionString: base.db.app, max: 2 });
  defaultApp = buildApp({ config: base, appPool });
  corsApp = buildApp({
    config: loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      CORS_ALLOWED_ORIGINS: `${ALLOWED}, https://other.example`,
    }),
    appPool,
  });
  await Promise.all([defaultApp.ready(), corsApp.ready()]);
}, 20_000);

afterAll(async () => {
  await Promise.all([defaultApp.close(), corsApp.close()]);
  await appPool.end();
});

describe('cabeceras de seguridad', () => {
  it('sets the hardening headers on every response', async () => {
    const res = await defaultApp.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
  });

  it('does not send HSTS in test/local (http)', async () => {
    const res = await defaultApp.inject({ method: 'GET', url: '/health' });
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });
});

describe('CORS de allowlist', () => {
  it('does NOT allow cross-origin by default (no allowlist)', async () => {
    const res = await defaultApp.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: ALLOWED },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('echoes an allowed origin and varies on Origin', async () => {
    const res = await corsApp.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: ALLOWED },
    });
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(String(res.headers['vary'])).toContain('Origin');
  });

  it('does not echo a disallowed origin', async () => {
    const res = await corsApp.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://evil.example' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers a preflight for an allowed origin with the method/header allowances', async () => {
    const res = await corsApp.inject({
      method: 'OPTIONS',
      url: '/v1/payment_intents',
      headers: {
        origin: ALLOWED,
        'access-control-request-method': 'POST',
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(String(res.headers['access-control-allow-methods'])).toContain('POST');
    expect(String(res.headers['access-control-allow-headers'])).toContain('idempotency-key');
  });

  it('answers a preflight for a disallowed origin WITHOUT the allow-origin header', async () => {
    const res = await corsApp.inject({
      method: 'OPTIONS',
      url: '/v1/payment_intents',
      headers: {
        origin: 'https://evil.example',
        'access-control-request-method': 'POST',
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-methods']).toBeUndefined();
  });
});
