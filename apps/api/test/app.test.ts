import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@fluvia/config';
import { createPool, type Pool } from '@fluvia/db';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

let app: FastifyInstance;
let appPool: Pool;

beforeAll(async () => {
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' });
  appPool = createPool({ connectionString: config.db.app, max: 2 });
  app = buildApp({ config, appPool });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await appPool.end();
});

describe('platform endpoints (F1-01)', () => {
  it('GET /health responds ok with environment', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.env).toBe('test');
  });

  it('GET /ready checks real database connectivity', async () => {
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ready');
  });

  it('GET /ready returns 503 when the database is unreachable', async () => {
    const deadPool = createPool({ connectionString: 'postgres://x:x@127.0.0.1:1/none', max: 1 });
    const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' });
    const brokenApp = buildApp({ config, appPool: deadPool });
    const res = await brokenApp.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    await brokenApp.close();
    await deadPool.end();
  });
});

describe('correlation id', () => {
  it('echoes a valid incoming x-request-id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'req-abc-123' },
    });
    expect(res.headers['x-request-id']).toBe('req-abc-123');
  });

  it('replaces a malicious/oversized request id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'bad id\nwith newline' },
    });
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('generates one when absent', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('stable error envelope (baseline for F1-08)', () => {
  it('unknown routes return the standard envelope', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error.code).toBe('not_found');
    expect(body.error.request_id).toBeTruthy();
  });
});
