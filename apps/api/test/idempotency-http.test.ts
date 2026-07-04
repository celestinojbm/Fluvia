import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@fluvia/config';
import { createTestContext, type TestContext } from '@fluvia/db/testing';
import {
  IdempotencyService,
  assertValidIdempotencyKey,
  computeRequestHash,
} from '@fluvia/idempotency';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

/**
 * F2-09 — la capa de idempotencia sobre HTTP real, con el sobre del catalogo.
 * La ruta sintetica reproduce EXACTAMENTE el cableado que usaran los
 * endpoints mutantes de pagos en F3-02: header -> hash canonico -> execute
 * con el efecto en la MISMA transaccion -> respuesta (o replay).
 */

let ctx: TestContext;
let app: FastifyInstance;
let org: string;

beforeAll(async () => {
  ctx = await createTestContext();
  org = await ctx.createTenant('Idem HTTP Org');
  const service = new IdempotencyService(ctx.app);

  app = buildApp({ config: loadConfig({}), appPool: ctx.app });
  app.post('/test/things', async (req, reply) => {
    const key = assertValidIdempotencyKey(req.headers['idempotency-key']);
    const body = req.body as { name: string };
    const result = await service.execute({
      tenantId: org,
      endpoint: 'POST /test/things',
      key,
      requestHash: computeRequestHash(body),
      handler: async (client) => {
        const res = await client.query<{ id: string }>(
          `INSERT INTO merchants (tenant_id, name) VALUES ($1, $2) RETURNING id`,
          [org, body.name]
        );
        return { status: 201, body: { id: res.rows[0]!.id, name: body.name } };
      },
    });
    reply.header('idempotency-replayed', String(result.replayed));
    return reply.code(result.status).send(result.body);
  });
  await app.ready();
}, 30_000);

afterAll(async () => {
  await app.close();
  await ctx.close();
});

describe('idempotencia sobre HTTP (contrato + catalogo v1)', () => {
  it('replays the exact response (status, body) and flags it via header', async () => {
    const key = `http-${randomUUID()}`;
    const payload = { name: `m-${randomUUID().slice(0, 8)}` };
    const first = await app.inject({
      method: 'POST',
      url: '/test/things',
      headers: { 'idempotency-key': key },
      payload,
    });
    expect(first.statusCode).toBe(201);
    expect(first.headers['idempotency-replayed']).toBe('false');

    const second = await app.inject({
      method: 'POST',
      url: '/test/things',
      headers: { 'idempotency-key': key },
      payload,
    });
    expect(second.statusCode).toBe(201);
    expect(second.headers['idempotency-replayed']).toBe('true');
    expect(second.json()).toEqual(first.json());

    const count = await ctx.admin.query(
      `SELECT count(*)::int AS n FROM merchants WHERE tenant_id = $1 AND name = $2`,
      [org, payload.name]
    );
    expect(count.rows[0]!.n).toBe(1);
  });

  it('missing header -> 400 idempotency_key_required with the catalog envelope', async () => {
    const res = await app.inject({ method: 'POST', url: '/test/things', payload: { name: 'x' } });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { type: string; code: string; request_id: string } };
    expect(body.error.code).toBe('idempotency_key_required');
    expect(body.error.type).toBe('validation_error');
    expect(body.error.request_id).toBeTruthy();
  });

  it('same key + different payload -> 422 idempotency_key_reuse', async () => {
    const key = `http-${randomUUID()}`;
    await app.inject({
      method: 'POST',
      url: '/test/things',
      headers: { 'idempotency-key': key },
      payload: { name: `m-${randomUUID().slice(0, 8)}` },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/test/things',
      headers: { 'idempotency-key': key },
      payload: { name: 'algo-distinto' },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json() as { error: { type: string; code: string } };
    expect(body.error.code).toBe('idempotency_key_reuse');
    expect(body.error.type).toBe('unprocessable_error');
  });
});
