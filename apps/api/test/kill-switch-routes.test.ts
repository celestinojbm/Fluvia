import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@fluvia/config';
import { createPool, type Pool } from '@fluvia/db';
import { AuthService } from '@fluvia/auth';
import { ApiKeyService, IdentityService } from '@fluvia/identity';
import { KillSwitchAdmin } from '@fluvia/payments-core';
import { buildApp } from '../src/app.js';

/**
 * #91 — el kill switch visto desde HTTP: el guard del motor (0046) llega al
 * cliente como `403 flow_suspended` con el sobre del catálogo, sin filtrar el
 * motivo del corte, sin dejar filas a medias y SIN quemar la Idempotency-Key
 * (tras liberar, el mismo request con la misma key se procesa por primera vez).
 */

let app: FastifyInstance;
let appPool: Pool;
let authPool: Pool;
let adminPool: Pool;
let killSwitches: KillSwitchAdmin;
let org: string;
let merchant: string;
let key: string;
const operator = randomUUID();
const toRelease: string[] = [];

const SECRET_REASON = 'motivo-confidencial-sanciones';

beforeAll(async () => {
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' });
  appPool = createPool({ connectionString: config.db.app, max: 4 });
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
  killSwitches = new KillSwitchAdmin(adminPool);

  const o = await adminPool.query<{ id: string }>(
    'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id',
    ['KS Org', `org-${randomUUID()}`]
  );
  org = o.rows[0]!.id;
  const m = await adminPool.query<{ id: string }>(
    'INSERT INTO merchants (tenant_id, name) VALUES ($1, $2) RETURNING id',
    [org, `ks-http-${randomUUID().slice(0, 8)}`]
  );
  merchant = m.rows[0]!.id;
  key = (await apiKeyService.create(org, { label: 'ks', scopes: ['read', 'payments:write'] }))
    .secret;
}, 30_000);

afterAll(async () => {
  for (const id of toRelease) {
    await killSwitches
      .release({ id, reason: 'test cleanup', actorId: operator })
      .catch(() => undefined);
  }
  await app.close();
  await Promise.all([appPool.end(), authPool.end(), adminPool.end()]);
});

async function engageMerchant(): Promise<string> {
  const { killSwitch } = await killSwitches.engage({
    scope: 'merchant',
    target: merchant,
    reason: SECRET_REASON,
    actorId: operator,
  });
  toRelease.push(killSwitch.id);
  return killSwitch.id;
}

async function release(id: string): Promise<void> {
  await killSwitches.release({ id, reason: 'reanudar', actorId: operator });
}

const post = (url: string, idem: string, payload: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${key}`, 'idempotency-key': idem },
    payload,
  });

const intentBody = () => ({ merchant_id: merchant, amount: 25_000, currency: 'COP' });

describe('kill switch sobre HTTP (#91)', () => {
  it('POST /v1/payment_intents → 403 flow_suspended; la key no se quema', async () => {
    const id = await engageMerchant();
    const idem = `ks-create-${randomUUID()}`;

    const blocked = await post('/v1/payment_intents', idem, intentBody());
    expect(blocked.statusCode).toBe(403);
    const body = blocked.json();
    expect(body.error.code).toBe('flow_suspended');
    expect(body.error.type).toBe('authorization_error');
    expect(blocked.body).not.toContain(SECRET_REASON);
    expect(blocked.body).not.toContain(id);

    const rows = await adminPool.query(`SELECT 1 FROM payment_intents WHERE merchant_id = $1`, [
      merchant,
    ]);
    expect(rows.rowCount).toBe(0);

    await release(id);
    const ok = await post('/v1/payment_intents', idem, intentBody());
    expect(ok.statusCode).toBe(201);
    expect(ok.headers['idempotency-replayed']).toBe('false');
  });

  it('POST /v1/payment_intents/:id/confirm → 403 y el intent queda donde estaba', async () => {
    const created = await post('/v1/payment_intents', `ks-pre-${randomUUID()}`, intentBody());
    expect(created.statusCode).toBe(201);
    const intentId = created.json().id as string;

    const id = await engageMerchant();
    const blocked = await post(`/v1/payment_intents/${intentId}/confirm`, `ks-c-${randomUUID()}`, {
      payment_method_token: 'tok_approve',
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('flow_suspended');

    const st = await adminPool.query<{ status: string }>(
      `SELECT status FROM payment_intents WHERE id = $1`,
      [intentId]
    );
    expect(st.rows[0]!.status).toBe('created');
    await release(id);
  });
});
