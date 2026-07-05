import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@fluvia/config';
import { createPool, type Pool } from '@fluvia/db';
import { MetricsRegistry } from '@fluvia/observability';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

let app: FastifyInstance;
let appPool: Pool;
let registry: MetricsRegistry;

beforeAll(async () => {
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' });
  appPool = createPool({ connectionString: config.db.app, max: 2 });
  registry = new MetricsRegistry();
  app = buildApp({ config, appPool, metricsRegistry: registry });
  // Ruta sembrada solo-test para observar el conteo de errores 5xx.
  app.get('/boom', () => {
    throw new Error('kaboom (interno, jamas visible al cliente)');
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await appPool.end();
});

describe('metricas HTTP del API (F1-07)', () => {
  it('GET /metrics exposes request counters and duration histograms per route template', async () => {
    await app.inject({ method: 'GET', url: '/health' });
    await app.inject({ method: 'GET', url: '/health' });
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.headers['content-type']).toContain('version=0.0.4');
    const body = res.body;
    expect(body).toContain('# TYPE fluvia_http_requests_total counter');
    expect(body).toContain(
      'fluvia_http_requests_total{method="GET",route="/health",status="200"} 2'
    );
    expect(body).toContain('# TYPE fluvia_http_request_duration_seconds histogram');
    expect(body).toContain(
      'fluvia_http_request_duration_seconds_count{method="GET",route="/health"} 2'
    );
    expect(body).toContain('le="+Inf"');
  });

  it('unmatched paths collapse into a single "unmatched" route label (anti-cardinalidad)', async () => {
    await app.inject({ method: 'GET', url: '/no/such/path/111' });
    await app.inject({ method: 'GET', url: '/no/such/path/222' });
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.body).toContain(
      'fluvia_http_requests_total{method="GET",route="unmatched",status="404"} 2'
    );
    expect(res.body).not.toContain('/no/such/path');
  });

  it('error responses are counted with their status (base para alertas de 5xx)', async () => {
    const boom = await app.inject({ method: 'GET', url: '/boom' });
    expect(boom.statusCode).toBe(500);
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.body).toContain(
      'fluvia_http_requests_total{method="GET",route="/boom",status="500"} 1'
    );
  });

  it('exposition never contains tenant-shaped identifiers (agregado anonimo)', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    // Ninguna serie debe contener UUIDs (ids de tenant/usuario/cuenta).
    expect(res.body).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });
});
