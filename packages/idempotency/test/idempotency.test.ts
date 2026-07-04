import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '@fluvia/db/testing';
import {
  IdempotencyKeyRequiredError,
  IdempotencyKeyReuseError,
  IdempotencyService,
  ProcessingInFlightError,
  assertValidIdempotencyKey,
  computeRequestHash,
  stableStringify,
} from '../src/index.js';

/**
 * F2-09/F2-10 — contrato de idempotency.md §3/§6 caso a caso, contra PG real.
 * "Efecto" = INSERT de un merchant en la MISMA transaccion que el claim: si
 * la capa falla, se nota en una tabla de dominio de verdad.
 */

let ctx: TestContext;
let service: IdempotencyService;
let org: string;

const ENDPOINT = 'POST /v1/test-effects';

function effectHandler(name: string, status = 201) {
  return async (client: import('@fluvia/db').PoolClient) => {
    const res = await client.query<{ id: string }>(
      `INSERT INTO merchants (tenant_id, name) VALUES ($1, $2) RETURNING id`,
      [org, name]
    );
    return { status, body: { merchant_id: res.rows[0]!.id, name } };
  };
}

async function effectCount(name: string): Promise<number> {
  const res = await ctx.admin.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM merchants WHERE tenant_id = $1 AND name = $2`,
    [org, name]
  );
  return res.rows[0]!.n;
}

beforeAll(async () => {
  ctx = await createTestContext();
  service = new IdempotencyService(ctx.app);
  org = await ctx.createTenant('Idempotency Org');
}, 30_000);

afterAll(async () => {
  await ctx.close();
});

describe('hash canonico', () => {
  it('is independent of key order and of undefined fields', () => {
    expect(computeRequestHash({ a: 1, b: [{ x: 1, y: 2 }] })).toBe(
      computeRequestHash({ b: [{ y: 2, x: 1 }], a: 1, skip: undefined })
    );
    expect(computeRequestHash({ a: 1 })).not.toBe(computeRequestHash({ a: 2 }));
    expect(stableStringify({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });

  it('validates the Idempotency-Key header format', () => {
    expect(assertValidIdempotencyKey('idem_abc-123')).toBe('idem_abc-123');
    for (const bad of [undefined, '', 'x'.repeat(256), 'con espacios', 'salto\nlinea']) {
      expect(() => assertValidIdempotencyKey(bad)).toThrow(IdempotencyKeyRequiredError);
    }
  });
});

describe('contrato idempotency.md §3', () => {
  it('CASE 1+2: new key executes ONCE and same key+hash replays the stored response', async () => {
    const key = `k-${randomUUID()}`;
    const name = `m-${randomUUID().slice(0, 8)}`;
    const hash = computeRequestHash({ name });

    const first = await service.execute({
      tenantId: org,
      endpoint: ENDPOINT,
      key,
      requestHash: hash,
      handler: effectHandler(name),
    });
    expect(first.replayed).toBe(false);
    expect(first.status).toBe(201);
    expect(await effectCount(name)).toBe(1);

    let handlerRan = false;
    const second = await service.execute({
      tenantId: org,
      endpoint: ENDPOINT,
      key,
      requestHash: hash,
      handler: async () => {
        handlerRan = true;
        return { status: 500, body: null };
      },
    });
    expect(handlerRan).toBe(false); // el handler JAMAS se re-ejecuta
    expect(second.replayed).toBe(true);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body); // replay EXACTO
    expect(await effectCount(name)).toBe(1);

    // expires_at poblado (~24h; la purga es F1-09).
    const row = await ctx.admin.query<{ hours: number }>(
      `SELECT round(extract(epoch FROM (expires_at - now())) / 3600)::int AS hours
       FROM idempotency_keys WHERE tenant_id = $1 AND key = $2`,
      [org, key]
    );
    expect(row.rows[0]!.hours).toBe(24);
  });

  it('CASE 4: same key with a DIFFERENT payload is rejected and never executed', async () => {
    const key = `k-${randomUUID()}`;
    const name = `m-${randomUUID().slice(0, 8)}`;
    await service.execute({
      tenantId: org,
      endpoint: ENDPOINT,
      key,
      requestHash: computeRequestHash({ name, amount: 100 }),
      handler: effectHandler(name),
    });
    let ran = false;
    await expect(
      service.execute({
        tenantId: org,
        endpoint: ENDPOINT,
        key,
        requestHash: computeRequestHash({ name, amount: 999 }),
        handler: async () => {
          ran = true;
          return { status: 201, body: null };
        },
      })
    ).rejects.toThrow(IdempotencyKeyReuseError);
    expect(ran).toBe(false);
    expect(await effectCount(name)).toBe(1);
  });

  it('CASE 3: a slow in-flight request makes the duplicate respond processing_in_flight', async () => {
    const fast = new IdempotencyService(ctx.app, { lockTimeoutMs: 200 });
    const key = `k-${randomUUID()}`;
    const name = `m-${randomUUID().slice(0, 8)}`;
    const hash = computeRequestHash({ name });

    const slow = fast.execute({
      tenantId: org,
      endpoint: ENDPOINT,
      key,
      requestHash: hash,
      handler: async (client) => {
        await client.query(`SELECT pg_sleep(0.8)`); // > lockTimeout del duplicado
        return effectHandler(name)(client);
      },
    });
    await new Promise((r) => setTimeout(r, 100)); // asegurar que el lento va primero
    await expect(
      fast.execute({
        tenantId: org,
        endpoint: ENDPOINT,
        key,
        requestHash: hash,
        handler: effectHandler(name),
      })
    ).rejects.toThrow(ProcessingInFlightError);

    const winner = await slow;
    expect(winner.replayed).toBe(false);
    expect(await effectCount(name)).toBe(1); // cero doble ejecucion

    // Terminada la request en vuelo, el reintento replaya.
    const retry = await fast.execute({
      tenantId: org,
      endpoint: ENDPOINT,
      key,
      requestHash: hash,
      handler: effectHandler(name),
    });
    expect(retry.replayed).toBe(true);
    expect(await effectCount(name)).toBe(1);
  });

  it('orphan COMMITTED in_progress: same hash waits (409), different hash is reuse (422)', async () => {
    const key = `k-${randomUUID()}`;
    const hash = computeRequestHash({ x: 1 });
    await ctx.admin.query(
      `INSERT INTO idempotency_keys (tenant_id, endpoint, key, request_hash, status)
       VALUES ($1, $2, $3, $4, 'in_progress')`,
      [org, ENDPOINT, key, hash]
    );
    await expect(
      service.execute({
        tenantId: org,
        endpoint: ENDPOINT,
        key,
        requestHash: hash,
        handler: async () => ({ status: 200, body: null }),
      })
    ).rejects.toThrow(ProcessingInFlightError);
    await expect(
      service.execute({
        tenantId: org,
        endpoint: ENDPOINT,
        key,
        requestHash: computeRequestHash({ x: 2 }),
        handler: async () => ({ status: 200, body: null }),
      })
    ).rejects.toThrow(IdempotencyKeyReuseError);
  });

  it('AUD-P1-009: the same key on a DIFFERENT endpoint executes independently', async () => {
    const key = `k-${randomUUID()}`;
    const nameA = `m-${randomUUID().slice(0, 8)}`;
    const nameB = `m-${randomUUID().slice(0, 8)}`;
    const a = await service.execute({
      tenantId: org,
      endpoint: 'POST /v1/endpoint-a',
      key,
      requestHash: computeRequestHash({ nameA }),
      handler: effectHandler(nameA),
    });
    const b = await service.execute({
      tenantId: org,
      endpoint: 'POST /v1/endpoint-b',
      key,
      requestHash: computeRequestHash({ nameB }),
      handler: effectHandler(nameB),
    });
    expect(a.replayed).toBe(false);
    expect(b.replayed).toBe(false);
  });
});

describe('F2-10: crash-recovery y carrera (Gate Idempotencia)', () => {
  it('crash BEFORE commit: neither key nor effect survive; the retry executes clean', async () => {
    const key = `k-${randomUUID()}`;
    const name = `m-${randomUUID().slice(0, 8)}`;
    const hash = computeRequestHash({ name });

    // "Muerte" pre-COMMIT: el handler revienta DESPUES de aplicar el efecto.
    await expect(
      service.execute({
        tenantId: org,
        endpoint: ENDPOINT,
        key,
        requestHash: hash,
        handler: async (client) => {
          await effectHandler(name)(client);
          throw new Error('process died before COMMIT');
        },
      })
    ).rejects.toThrow(/died before COMMIT/);

    expect(await effectCount(name)).toBe(0); // rollback conjunto
    const keyRow = await ctx.admin.query(
      `SELECT 1 FROM idempotency_keys WHERE tenant_id = $1 AND key = $2`,
      [org, key]
    );
    expect(keyRow.rowCount).toBe(0); // la key tampoco sobrevivio

    // Reintento limpio: ejecuta exactamente una vez.
    const retry = await service.execute({
      tenantId: org,
      endpoint: ENDPOINT,
      key,
      requestHash: hash,
      handler: effectHandler(name),
    });
    expect(retry.replayed).toBe(false);
    expect(await effectCount(name)).toBe(1);
  });

  it('crash AFTER commit (died before responding): the retry replays without re-executing', async () => {
    const key = `k-${randomUUID()}`;
    const name = `m-${randomUUID().slice(0, 8)}`;
    const hash = computeRequestHash({ name });
    // La primera request commiteo (efecto + respuesta persistidos) y el
    // proceso murio ANTES de responder al cliente: eso ES el estado post-COMMIT.
    const first = await service.execute({
      tenantId: org,
      endpoint: ENDPOINT,
      key,
      requestHash: hash,
      handler: effectHandler(name),
    });
    const retry = await service.execute({
      tenantId: org,
      endpoint: ENDPOINT,
      key,
      requestHash: hash,
      handler: effectHandler(name),
    });
    expect(retry).toEqual({ ...first, replayed: true });
    expect(await effectCount(name)).toBe(1);
  });

  it('RACE: N concurrent requests with the same key produce EXACTLY one effect', async () => {
    const key = `k-${randomUUID()}`;
    const name = `m-${randomUUID().slice(0, 8)}`;
    const hash = computeRequestHash({ name });
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        service.execute({
          tenantId: org,
          endpoint: ENDPOINT,
          key,
          requestHash: hash,
          handler: effectHandler(name),
        })
      )
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    const executed = ok.filter((r) => !r.value.replayed);
    const inFlight = results.filter(
      (r) => r.status === 'rejected' && r.reason instanceof ProcessingInFlightError
    );
    expect(executed).toHaveLength(1); // N -> 1
    expect(ok.length + inFlight.length).toBe(8); // nadie fallo por otra causa
    expect(await effectCount(name)).toBe(1);
  });

  it('PROPERTY: for any retry sequence (failures included), total effects == 1', async () => {
    const key = `k-${randomUUID()}`;
    const name = `m-${randomUUID().slice(0, 8)}`;
    const hash = computeRequestHash({ name });
    const outcomes: string[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        const res = await service.execute({
          tenantId: org,
          endpoint: ENDPOINT,
          key,
          requestHash: hash,
          handler: async (client) => {
            const r = await effectHandler(name)(client);
            if (attempt < 2) throw new Error(`simulated crash #${attempt}`); // 2 fallos pre-COMMIT
            return r;
          },
        });
        outcomes.push(res.replayed ? 'replayed' : 'executed');
      } catch {
        outcomes.push('failed');
      }
    }
    expect(outcomes).toEqual(['failed', 'failed', 'executed', 'replayed', 'replayed', 'replayed']);
    expect(await effectCount(name)).toBe(1);
  });
});
