import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@fluvia/config';
import { createPool, type Pool } from '@fluvia/db';
import { AuthService } from '@fluvia/auth';
import { ApiKeyService, IdentityService } from '@fluvia/identity';
import { buildApp } from '../src/app.js';

/**
 * F3-07 — gestion de endpoints de webhook por HTTP real: scope
 * `webhooks:manage`, secreto whsec_ entregado UNA sola vez (jamas listable),
 * rotacion, disable y aislamiento por tenant (cross-tenant = 404 indistinguible).
 */

let app: FastifyInstance;
let appPool: Pool;
let authPool: Pool;
let adminPool: Pool;
let apiKeyService: ApiKeyService;

let orgA: string;
let orgB: string;
let keyA: string; // webhooks:manage
let keyARead: string; // solo read
let keyB: string; // webhooks:manage, otro tenant

async function createOrg(name: string): Promise<string> {
  const res = await adminPool.query<{ id: string }>(
    'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id',
    [name, `org-${randomUUID()}`]
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
  apiKeyService = new ApiKeyService(appPool);
  app = buildApp({
    config,
    appPool,
    authService: new AuthService(authPool),
    identityService: new IdentityService(appPool),
    apiKeyService,
  });
  await app.ready();

  orgA = await createOrg('WHE Org A');
  orgB = await createOrg('WHE Org B');
  keyA = (await apiKeyService.create(orgA, { label: 'whe-a', scopes: ['read', 'webhooks:manage'] }))
    .secret;
  keyARead = (await apiKeyService.create(orgA, { label: 'whe-a-ro', scopes: ['read'] })).secret;
  keyB = (await apiKeyService.create(orgB, { label: 'whe-b', scopes: ['read', 'webhooks:manage'] }))
    .secret;
}, 30_000);

afterAll(async () => {
  await app.close();
  await Promise.all([appPool.end(), authPool.end(), adminPool.end()]);
});

describe('POST /v1/webhook_endpoints', () => {
  it('creates the endpoint and returns the whsec_ secret exactly ONCE', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhook_endpoints',
      headers: auth(keyA),
      payload: {
        url: 'http://127.0.0.1:9099/hooks',
        events: ['payment_intent.succeeded', 'refund.succeeded'],
        description: 'listener de la tienda',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.object).toBe('webhook_endpoint');
    expect(body.status).toBe('active');
    expect(body.secret).toMatch(/^whsec_[0-9a-f]{48}$/);
    expect(body.events).toEqual(['payment_intent.succeeded', 'refund.succeeded']);

    // El listado JAMAS vuelve a exponer el secreto (ni cifrado ni en claro).
    const list = await app.inject({
      method: 'GET',
      url: '/v1/webhook_endpoints',
      headers: auth(keyA),
    });
    expect(list.statusCode).toBe(200);
    const found = list.json().data.find((e: { id: string }) => e.id === body.id);
    expect(found).toBeTruthy();
    expect(found).not.toHaveProperty('secret');
    expect(JSON.stringify(list.json())).not.toContain('whsec_');
  });

  it('rejects topics outside the catalog and unsafe URLs (validation_error)', async () => {
    const badTopic = await app.inject({
      method: 'POST',
      url: '/v1/webhook_endpoints',
      headers: auth(keyA),
      payload: { url: 'http://127.0.0.1:9099/x', events: ['ledger.transaction.posted'] },
    });
    expect(badTopic.statusCode).toBe(400);
    expect(badTopic.json().error.code).toBe('validation_error');

    // Credenciales embebidas: rechazadas incluso en local/test.
    const badUrl = await app.inject({
      method: 'POST',
      url: '/v1/webhook_endpoints',
      headers: auth(keyA),
      payload: { url: 'https://user:pass@example.com/hook' },
    });
    expect(badUrl.statusCode).toBe(400);
    expect(badUrl.json().error.code).toBe('validation_error');

    // RA-F65B-EXT-001: query/fragment portadores de credenciales — mismo
    // rechazo en el plano de API key, sin reflejar el secreto en el error.
    for (const url of [
      'http://127.0.0.1:9099/hook?token=EXTKEYSECRET',
      'http://127.0.0.1:9099/hook?access_token=EXTKEYSECRET',
      'http://127.0.0.1:9099/hook#EXTKEYSECRET',
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/webhook_endpoints',
        headers: auth(keyA),
        payload: { url },
      });
      expect(res.statusCode, url).toBe(400);
      expect(res.json().error.code, url).toBe('validation_error');
      expect(res.body, url).not.toContain('EXTKEYSECRET');
    }
  });

  it('requires the webhooks:manage scope (403 insufficient_scope)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhook_endpoints',
      headers: auth(keyARead),
      payload: { url: 'http://127.0.0.1:9099/hooks' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('insufficient_scope');
  });
});

describe('rotacion y disable', () => {
  it('rotate returns a NEW secret; the old endpoint keeps its identity', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/webhook_endpoints',
      headers: auth(keyA),
      payload: { url: 'http://127.0.0.1:9099/rotate-me' },
    });
    const { id, secret } = created.json();

    const rotated = await app.inject({
      method: 'POST',
      url: `/v1/webhook_endpoints/${id}/rotate`,
      headers: auth(keyA),
    });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json().secret).toMatch(/^whsec_[0-9a-f]{48}$/);
    expect(rotated.json().secret).not.toBe(secret);
  });

  it('disable stops the endpoint; rotating a disabled endpoint is 404', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/webhook_endpoints',
      headers: auth(keyA),
      payload: { url: 'http://127.0.0.1:9099/disable-me' },
    });
    const { id } = created.json();

    const disabled = await app.inject({
      method: 'POST',
      url: `/v1/webhook_endpoints/${id}/disable`,
      headers: auth(keyA),
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().status).toBe('disabled');
    expect(disabled.json().disabled_at).toBeTruthy();

    const rotate = await app.inject({
      method: 'POST',
      url: `/v1/webhook_endpoints/${id}/rotate`,
      headers: auth(keyA),
    });
    expect(rotate.statusCode).toBe(404);
    expect(rotate.json().error.code).toBe('not_found');
  });

  it('cross-tenant: another tenant cannot see, rotate or disable the endpoint (404)', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/webhook_endpoints',
      headers: auth(keyA),
      payload: { url: 'http://127.0.0.1:9099/mine' },
    });
    const { id } = created.json();

    const list = await app.inject({
      method: 'GET',
      url: '/v1/webhook_endpoints',
      headers: auth(keyB),
    });
    expect(list.json().data.map((e: { id: string }) => e.id)).not.toContain(id);

    for (const action of ['rotate', 'disable']) {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/webhook_endpoints/${id}/${action}`,
        headers: auth(keyB),
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('not_found');
    }
  });
});
