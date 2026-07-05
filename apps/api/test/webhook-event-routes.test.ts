import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@fluvia/config';
import { createPool, type Pool } from '@fluvia/db';
import { AuthService } from '@fluvia/auth';
import { ApiKeyService, IdentityService } from '@fluvia/identity';
import { buildApp } from '../src/app.js';

/**
 * F3-09a — cola de webhooks + reenvío `dead` sobre HTTP real: lectura con scope
 * `read`, reenvío con `webhooks:manage`, aislamiento por tenant y el guard de
 * "solo eventos dead se reenvían".
 */

let app: FastifyInstance;
let appPool: Pool;
let authPool: Pool;
let adminPool: Pool;

let orgA: string;
let orgB: string;
let endpointA: string;
let keyReadA: string;
let keyManageA: string;
let keyManageB: string;

async function createOrg(name: string): Promise<string> {
  const res = await adminPool.query<{ id: string }>(
    'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id',
    [name, `org-${randomUUID()}`]
  );
  return res.rows[0]!.id;
}
async function seedEndpoint(tenantId: string): Promise<string> {
  const res = await adminPool.query<{ id: string }>(
    `INSERT INTO webhook_endpoints (tenant_id, url, secret_enc, events)
     VALUES ($1, 'https://example.test/hook', 'enc:dummy', '{}') RETURNING id`,
    [tenantId]
  );
  return res.rows[0]!.id;
}
async function seedEvent(
  tenantId: string,
  endpointId: string,
  status: 'pending' | 'delivered' | 'dead'
): Promise<string> {
  const res = await adminPool.query<{ id: string }>(
    `INSERT INTO webhook_events (tenant_id, endpoint_id, topic, payload, status, attempts, last_error)
     VALUES ($1, $2, 'merchant.updated', $3, $4, $5, $6) RETURNING id`,
    [
      tenantId,
      endpointId,
      JSON.stringify({ event_id: `evt_${randomUUID()}` }),
      status,
      status === 'dead' ? 7 : 0,
      status === 'dead' ? 'non-2xx response: 500' : null,
    ]
  );
  return res.rows[0]!.id;
}
function auth(key: string) {
  return { authorization: `Bearer ${key}` };
}

beforeAll(async () => {
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' });
  appPool = createPool({ connectionString: config.db.app, max: 6 });
  authPool = createPool({ connectionString: config.db.auth, max: 2 });
  adminPool = createPool({ connectionString: config.db.admin, max: 2 });
  const apiKeyService = new ApiKeyService(appPool);
  app = buildApp({
    config,
    appPool,
    authService: new AuthService(authPool),
    identityService: new IdentityService(appPool),
    apiKeyService,
  });
  await app.ready();

  orgA = await createOrg('WHE-R Org A');
  orgB = await createOrg('WHE-R Org B');
  endpointA = await seedEndpoint(orgA);
  keyReadA = (await apiKeyService.create(orgA, { label: 'ro', scopes: ['read'] })).secret;
  keyManageA = (
    await apiKeyService.create(orgA, { label: 'mgr', scopes: ['read', 'webhooks:manage'] })
  ).secret;
  keyManageB = (
    await apiKeyService.create(orgB, { label: 'mgr-b', scopes: ['read', 'webhooks:manage'] })
  ).secret;
}, 30_000);

afterAll(async () => {
  await app.close();
  await Promise.all([appPool.end(), authPool.end(), adminPool.end()]);
});

describe('lectura de la cola', () => {
  it('lists and shows detail with attempt history (scope read)', async () => {
    const dead = await seedEvent(orgA, endpointA, 'dead');
    await adminPool.query(
      `INSERT INTO webhook_attempts
         (tenant_id, webhook_event_id, attempt_number, status_code, error, latency_ms)
       VALUES ($1, $2, 1, 500, 'boom', 12)`,
      [orgA, dead]
    );

    const list = await app.inject({
      method: 'GET',
      url: '/v1/webhook_events?status=dead&limit=100',
      headers: auth(keyReadA),
    });
    expect(list.statusCode).toBe(200);
    expect((list.json().data as Array<{ id: string }>).some((e) => e.id === dead)).toBe(true);

    const detail = await app.inject({
      method: 'GET',
      url: `/v1/webhook_events/${dead}`,
      headers: auth(keyReadA),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().object).toBe('webhook_event');
    expect(detail.json().attempts_history).toHaveLength(1);
    expect(detail.json().attempts_history[0].status_code).toBe(500);
  });

  it("returns 404 for another tenant's event (anti-enumeration)", async () => {
    const dead = await seedEvent(orgA, endpointA, 'dead');
    const foreign = await app.inject({
      method: 'GET',
      url: `/v1/webhook_events/${dead}`,
      headers: auth(keyManageB),
    });
    expect(foreign.statusCode).toBe(404);
  });
});

describe('reenvío', () => {
  it('resends a dead event as a fresh pending one (scope webhooks:manage)', async () => {
    const dead = await seedEvent(orgA, endpointA, 'dead');
    const res = await app.inject({
      method: 'POST',
      url: `/v1/webhook_events/${dead}/resend`,
      headers: auth(keyManageA),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('pending');
    expect(res.json().resent_from_event_id).toBe(dead);
    expect(res.json().id).not.toBe(dead);
  });

  it('requires webhooks:manage (read is not enough)', async () => {
    const dead = await seedEvent(orgA, endpointA, 'dead');
    const res = await app.inject({
      method: 'POST',
      url: `/v1/webhook_events/${dead}/resend`,
      headers: auth(keyReadA),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('insufficient_scope');
  });

  it('refuses to resend a non-dead event (409)', async () => {
    const delivered = await seedEvent(orgA, endpointA, 'delivered');
    const res = await app.inject({
      method: 'POST',
      url: `/v1/webhook_events/${delivered}/resend`,
      headers: auth(keyManageA),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('invalid_state_transition');
  });

  it('returns 404 for an unknown event', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/webhook_events/${randomUUID()}/resend`,
      headers: auth(keyManageA),
    });
    expect(res.statusCode).toBe(404);
  });
});
