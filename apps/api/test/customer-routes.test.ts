import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@fluvia/config';
import { createPool, type Pool } from '@fluvia/db';
import { AuthService } from '@fluvia/auth';
import { ApiKeyService, IdentityService } from '@fluvia/identity';
import { buildApp } from '../src/app.js';

/**
 * F3-05a — customers sobre HTTP real: scopes (customers:write vs read),
 * validación del catálogo, aislamiento por tenant (404 indistinguible) y el
 * ciclo create/get/list/update/delete.
 */

let app: FastifyInstance;
let appPool: Pool;
let authPool: Pool;
let adminPool: Pool;
let apiKeyService: ApiKeyService;

let orgA: string;
let orgB: string;
let keyA: string; // read + customers:write
let keyARead: string; // solo read
let keyB: string; // otro tenant, customers:write + read

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

  orgA = await createOrg('Cust Org A');
  orgB = await createOrg('Cust Org B');
  keyA = (await apiKeyService.create(orgA, { label: 'c-a', scopes: ['read', 'customers:write'] }))
    .secret;
  keyARead = (await apiKeyService.create(orgA, { label: 'c-a-ro', scopes: ['read'] })).secret;
  keyB = (await apiKeyService.create(orgB, { label: 'c-b', scopes: ['read', 'customers:write'] }))
    .secret;
}, 30_000);

afterAll(async () => {
  await app.close();
  await Promise.all([appPool.end(), authPool.end(), adminPool.end()]);
});

async function createCustomer(key = keyA, payload: Record<string, unknown> = { name: 'Test' }) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/customers',
    headers: auth(key),
    payload,
  });
  return res;
}

describe('POST /v1/customers', () => {
  it('creates a customer and echoes whitelisted fields', async () => {
    const res = await createCustomer(keyA, {
      email: 'buyer@example.com',
      name: 'Buyer',
      metadata: { plan: 'gold' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.object).toBe('customer');
    expect(body.email).toBe('buyer@example.com');
    expect(body.metadata).toEqual({ plan: 'gold' });
    expect(body).not.toHaveProperty('tenant_id');
    expect(body).not.toHaveProperty('deleted_at');
  });

  it('rejects a body with no identifier (400 validation_error)', async () => {
    const res = await createCustomer(keyA, { description: 'nada más' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
  });

  it('requires the customers:write scope (403)', async () => {
    const res = await createCustomer(keyARead, { name: 'NoScope' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('insufficient_scope');
  });

  it('unauthenticated is 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/customers', payload: { name: 'x' } });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET + update + delete + aislamiento', () => {
  it('GET returns the customer; the other tenant gets 404', async () => {
    const id = (await createCustomer()).json().id as string;
    const mine = await app.inject({
      method: 'GET',
      url: `/v1/customers/${id}`,
      headers: auth(keyARead),
    });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().id).toBe(id);

    const foreign = await app.inject({
      method: 'GET',
      url: `/v1/customers/${id}`,
      headers: auth(keyB),
    });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().error.code).toBe('not_found');
  });

  it('update changes present fields; foreign tenant update is 404', async () => {
    const id = (await createCustomer(keyA, { name: 'Before', phone: '+57 1' })).json().id as string;
    const upd = await app.inject({
      method: 'POST',
      url: `/v1/customers/${id}`,
      headers: auth(keyA),
      payload: { name: 'After', phone: null },
    });
    expect(upd.statusCode).toBe(200);
    expect(upd.json().name).toBe('After');
    expect(upd.json().phone).toBeNull();

    const foreign = await app.inject({
      method: 'POST',
      url: `/v1/customers/${id}`,
      headers: auth(keyB),
      payload: { name: 'Hack' },
    });
    expect(foreign.statusCode).toBe(404);
  });

  it('delete hides the customer and is idempotent', async () => {
    const id = (await createCustomer()).json().id as string;
    const del = await app.inject({
      method: 'POST',
      url: `/v1/customers/${id}/delete`,
      headers: auth(keyA),
    });
    expect(del.statusCode).toBe(200);
    expect(del.json().deleted).toBe(true);

    const get = await app.inject({
      method: 'GET',
      url: `/v1/customers/${id}`,
      headers: auth(keyA),
    });
    expect(get.statusCode).toBe(404);

    // Idempotente: borrar de nuevo no es error de estado.
    const del2 = await app.inject({
      method: 'POST',
      url: `/v1/customers/${id}/delete`,
      headers: auth(keyA),
    });
    expect(del2.statusCode).toBe(200);
  });

  it('list is tenant-scoped', async () => {
    const id = (await createCustomer(keyA, { name: 'Listed' })).json().id as string;
    const mine = await app.inject({
      method: 'GET',
      url: '/v1/customers?limit=100',
      headers: auth(keyARead),
    });
    expect((mine.json().data as Array<{ id: string }>).some((c) => c.id === id)).toBe(true);

    const other = await app.inject({
      method: 'GET',
      url: '/v1/customers?limit=100',
      headers: auth(keyB),
    });
    expect((other.json().data as Array<{ id: string }>).some((c) => c.id === id)).toBe(false);
  });
});

describe('POST /v1/customers/:id/erase (TM-05 — derecho al olvido)', () => {
  it('pseudonymizes PII irreversibly, keeps the row, audits, and is idempotent', async () => {
    const created = await createCustomer(keyA, {
      name: 'Olvidable Pérez',
      email: 'olvidable@test.fluvia.dev',
      phone: '+57 300 111 2233',
      description: 'cliente VIP',
      metadata: { nickname: 'olvi' },
    });
    const id = created.json().id as string;

    const erased = await app.inject({
      method: 'POST',
      url: `/v1/customers/${id}/erase`,
      headers: auth(keyA),
    });
    expect(erased.statusCode).toBe(200);
    expect(erased.json()).toEqual({ id, object: 'customer', erased: true });

    // La fila PERMANECE (integridad referencial/contable) pero sin PII.
    const row = await adminPool.query<{
      email: string | null;
      name: string | null;
      phone: string | null;
      description: string | null;
      metadata: { pii_erased?: boolean };
      deleted_at: Date | null;
    }>(
      `SELECT email, name, phone, description, metadata, deleted_at
       FROM customers WHERE id = $1`,
      [id]
    );
    expect(row.rows[0]).toBeDefined();
    expect(row.rows[0]!.email).toBeNull();
    expect(row.rows[0]!.name).toBeNull();
    expect(row.rows[0]!.phone).toBeNull();
    expect(row.rows[0]!.description).toBeNull();
    expect(row.rows[0]!.metadata).toEqual({ pii_erased: true });
    expect(row.rows[0]!.deleted_at).not.toBeNull();

    // La PII original no existe en NINGUNA columna de la fila.
    const leak = await adminPool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM customers
       WHERE id = $1 AND (customers::text ILIKE '%olvidable%' OR customers::text LIKE '%300 111%')`,
      [id]
    );
    expect(leak.rows[0]!.n).toBe('0');

    // Auditado en la misma transacción, riesgo alto, sin la PII en el evento.
    const audit = await adminPool.query<{ risk_level: string; reason: string }>(
      `SELECT risk_level, reason FROM audit_events
       WHERE action = 'customer.pii_erased' AND resource_id = $1`,
      [id]
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.risk_level).toBe('high');
    expect(audit.rows[0]!.reason).toBe('right_to_erasure');

    // Desaparece del plano de lectura (como un soft-delete).
    const got = await app.inject({
      method: 'GET',
      url: `/v1/customers/${id}`,
      headers: auth(keyARead),
    });
    expect(got.statusCode).toBe(404);

    // Idempotente: borrar de nuevo devuelve lo mismo.
    const again = await app.inject({
      method: 'POST',
      url: `/v1/customers/${id}/erase`,
      headers: auth(keyA),
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().erased).toBe(true);
  });

  it('requires customers:write and is tenant-isolated (404 for a foreign customer)', async () => {
    const id = (await createCustomer(keyA, { name: 'Aislado' })).json().id as string;
    const wrongScope = await app.inject({
      method: 'POST',
      url: `/v1/customers/${id}/erase`,
      headers: auth(keyARead),
    });
    expect(wrongScope.statusCode).toBe(403);
    const foreign = await app.inject({
      method: 'POST',
      url: `/v1/customers/${id}/erase`,
      headers: auth(keyB),
    });
    expect(foreign.statusCode).toBe(404);
  });
});
