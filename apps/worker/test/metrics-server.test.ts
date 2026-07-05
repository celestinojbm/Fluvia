import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { MetricsRegistry } from '@fluvia/observability';
import { createMetricsServer } from '../src/metrics-server.js';

let server: Server;
let base: string;
const registry = new MetricsRegistry();
const beats = registry.counter('fluvia_worker_heartbeats_total', 'Latidos');

beforeAll(async () => {
  server = createMetricsServer({
    registry,
    healthInfo: () => ({ heartbeats: 7, env: 'test' }),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
});

describe('worker metrics server (F1-07)', () => {
  it('GET /health returns process status as JSON', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(body.heartbeats).toBe(7);
  });

  it('GET /metrics serves the Prometheus exposition', async () => {
    beats.inc({}, 3);
    const res = await fetch(`${base}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('version=0.0.4');
    const text = await res.text();
    expect(text).toContain('fluvia_worker_heartbeats_total 3');
  });

  it('anything else is 404 and non-GET is 405 (superficie minima)', async () => {
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}/admin`)).status).toBe(404);
    expect((await fetch(`${base}/metrics`, { method: 'POST' })).status).toBe(405);
  });
});
