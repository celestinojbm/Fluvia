import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '@fluvia/db/testing';
import { createPool, dbUrlsFromEnv, type Pool, type PoolClient } from '@fluvia/db';
import { IdempotencyService, computeRequestHash } from '../src/index.js';

/**
 * RA-F6-001 (re-auditoría F6 delta) — la transacción idempotente debe correr
 * con las TRES cotas de tiempo de V2-R1 (`statement_timeout`, `lock_timeout`,
 * `idle_in_transaction_session_timeout`), no solo `lock_timeout`. Se prueba
 * contra PG16 real:
 *   (1) las tres cotas quedan ACTIVAS dentro de la tx del servicio (y el
 *       contexto de tenant sigue correcto);
 *   (2) un handler con una sentencia lenta ABORTA por statement_timeout, con
 *       rollback atómico (ni key ni efecto) y retry limpio;
 *   (3) una sesión idle DENTRO de la tx es abortada por Postgres, sin dejar
 *       conexión colgada — el pool queda usable y el retry ejecuta limpio;
 *   (4) una secuencia de fallos por timeout NO agota un pool pequeño (los
 *       clients se liberan siempre);
 *   (5) la configuración se valida en el constructor (incluida la regla
 *       statement > lock que preserva el contrato 55P03 → 409).
 *
 * Se usa un pool DEDICADO max=2: las aserciones de liberación/reuso serían
 * vacuas sobre el pool compartido del contexto, y el kill de idle-in-tx no
 * debe envenenar conexiones de otros archivos de test.
 */

let ctx: TestContext;
let pool: Pool;
let org: string;

const ENDPOINT = 'POST /v1/tx-timeout-effects';

function input(key: string, name: string, handler: (c: PoolClient) => Promise<unknown>) {
  return {
    tenantId: org,
    endpoint: ENDPOINT,
    key,
    requestHash: computeRequestHash({ name }),
    handler: async (c: PoolClient) => {
      const out = await handler(c);
      return { status: 201, body: out ?? { name } };
    },
  };
}

/** Efecto de dominio real, como en idempotency.test.ts. */
function insertEffect(name: string) {
  return async (c: PoolClient) => {
    await c.query(`INSERT INTO merchants (tenant_id, name) VALUES ($1, $2)`, [org, name]);
    return { name };
  };
}

async function effectCount(name: string): Promise<number> {
  const res = await ctx.admin.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM merchants WHERE tenant_id = $1 AND name = $2`,
    [org, name]
  );
  return res.rows[0]!.n;
}

async function keyRowCount(key: string): Promise<number> {
  const res = await ctx.admin.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM idempotency_keys
     WHERE tenant_id = $1 AND endpoint = $2 AND key = $3`,
    [org, ENDPOINT, key]
  );
  return res.rows[0]!.n;
}

/**
 * node-pg puede entregar UNA vez una conexión recién matada antes de
 * descartarla (comportamiento documentado en pool-resilience.test.ts): el
 * "pool usable" se afirma con un reintento acotado, no en el primer intento.
 */
async function assertPoolUsable(): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const res = await pool.query('SELECT 1 AS ok');
      expect(res.rows[0]).toEqual({ ok: 1 });
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw lastErr;
}

beforeAll(async () => {
  ctx = await createTestContext();
  pool = createPool({ connectionString: dbUrlsFromEnv().app, max: 2 });
  org = await ctx.createTenant('RA-F6-001 Org');
}, 30_000);

afterAll(async () => {
  await pool.end();
  await ctx.close();
});

describe('RA-F6-001 — cotas de tiempo dentro de la tx idempotente', () => {
  it('applies the THREE V2-R1 bounds as SET LOCAL inside the idempotent tx (tenant intact)', async () => {
    const svc = new IdempotencyService(pool, {
      lockTimeoutMs: 2_000,
      statementTimeoutMs: 5_000,
      idleInTxTimeoutMs: 10_000,
    });
    const show = async (c: PoolClient, setting: string) =>
      Object.values((await c.query(`SHOW ${setting}`)).rows[0]!)[0] as string;
    const result = await svc.execute(
      input(`limits-${randomUUID()}`, 'limits', async (c) => ({
        statement: await show(c, 'statement_timeout'),
        lock: await show(c, 'lock_timeout'),
        idle: await show(c, 'idle_in_transaction_session_timeout'),
        tenant: (await c.query(`SELECT current_setting('app.tenant_id') AS t`)).rows[0]!.t,
      }))
    );
    expect(result.replayed).toBe(false);
    expect(result.body).toEqual({ statement: '5s', lock: '2s', idle: '10s', tenant: org });
  });

  it('statement_timeout aborts a slow handler: atomic rollback (no key, no effect), clean retry', async () => {
    const svc = new IdempotencyService(pool, { lockTimeoutMs: 100, statementTimeoutMs: 200 });
    const key = `st-${randomUUID()}`;
    const name = `st-${randomUUID().slice(0, 8)}`;

    await expect(
      svc.execute(
        input(key, name, async (c) => {
          await insertEffect(name)(c);
          await c.query('SELECT pg_sleep(2)'); // >> statementTimeoutMs
        })
      )
    ).rejects.toMatchObject({ code: '57014' }); // canceling statement due to statement timeout

    // Rollback conjunto: ni respuesta idempotente falsa ni efecto persistidos.
    expect(await keyRowCount(key)).toBe(0);
    expect(await effectCount(name)).toBe(0);

    // Contrato crash-before-commit: el retry con la MISMA key ejecuta limpio.
    const retry = await svc.execute(input(key, name, insertEffect(name)));
    expect(retry.replayed).toBe(false);
    expect(await effectCount(name)).toBe(1);
    expect(await keyRowCount(key)).toBe(1);
  });

  it('idle_in_transaction_session_timeout aborts an idle tx: no orphan state, pool stays usable', async () => {
    const svc = new IdempotencyService(pool, { idleInTxTimeoutMs: 150 });
    const key = `idle-${randomUUID()}`;
    const name = `idle-${randomUUID().slice(0, 8)}`;

    // El handler deja la sesión IDLE dentro de la tx (espera del lado JS, sin
    // sentencia en vuelo) mucho más que la cota: Postgres termina el backend
    // (FATAL 25P06/25P03) de forma determinista y la siguiente query rechaza.
    await expect(
      svc.execute(
        input(key, name, async (c) => {
          await insertEffect(name)(c);
          await new Promise((r) => setTimeout(r, 600)); // 4x la cota de 150ms
          await c.query('SELECT 1'); // la conexión ya fue terminada por el server
        })
      )
    ).rejects.toThrow();

    // La tx fue abortada del lado del servidor: nada quedó persistido.
    expect(await keyRowCount(key)).toBe(0);
    expect(await effectCount(name)).toBe(0);

    // El client no queda colgado: el pool entrega conexión y ejecuta.
    await assertPoolUsable();

    // Y el retry de la MISMA key ejecuta limpio sobre una conexión fresca.
    const retry = await svc.execute(input(key, name, insertEffect(name)));
    expect(retry.replayed).toBe(false);
    expect(await effectCount(name)).toBe(1);
  });

  it('a small sequence of timeout failures does NOT exhaust a max=2 pool (clients released)', async () => {
    const svc = new IdempotencyService(pool, { lockTimeoutMs: 100, statementTimeoutMs: 200 });
    // 4 fallos seguidos > max del pool: si un client se filtrara por error, el
    // tercer intento se colgaría hasta connectionTimeoutMillis y esto fallaría.
    for (let i = 0; i < 4; i += 1) {
      await expect(
        svc.execute(
          input(`leak-${i}-${randomUUID()}`, `leak-${i}`, (c) => c.query('SELECT pg_sleep(2)'))
        )
      ).rejects.toMatchObject({ code: '57014' });
    }
    await assertPoolUsable();
    const ok = await svc.execute(input(`leak-ok-${randomUUID()}`, 'leak-ok', async () => 'done'));
    expect(ok.replayed).toBe(false);
  }, 15_000);

  it('validates the timeout configuration at construction (55P03 contract preserved)', () => {
    // statement debe ser > lock: si no, un claim bloqueado podría abortar como
    // 57014 crudo en vez del 409 processing_in_flight documentado.
    expect(
      () => new IdempotencyService(pool, { lockTimeoutMs: 5_000, statementTimeoutMs: 5_000 })
    ).toThrow(RangeError);
    expect(() => new IdempotencyService(pool, { statementTimeoutMs: 0 })).toThrow(RangeError);
    expect(() => new IdempotencyService(pool, { statementTimeoutMs: Number.NaN })).toThrow(
      RangeError
    );
    expect(() => new IdempotencyService(pool, { idleInTxTimeoutMs: 0 })).toThrow(RangeError);
    expect(() => new IdempotencyService(pool, { idleInTxTimeoutMs: 2_147_483_648 })).toThrow(
      RangeError
    );
    // La configuración por defecto y una válida explícita construyen bien.
    expect(() => new IdempotencyService(pool)).not.toThrow();
    expect(
      () =>
        new IdempotencyService(pool, {
          lockTimeoutMs: 3_000,
          statementTimeoutMs: 30_000,
          idleInTxTimeoutMs: 60_000,
        })
    ).not.toThrow();
  });
});
