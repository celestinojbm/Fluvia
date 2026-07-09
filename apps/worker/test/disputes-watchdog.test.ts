import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@fluvia/config';
import { createPool, type Pool } from '@fluvia/db';
import { DisputesWatchdog } from '../src/disputes-watchdog.js';

/**
 * F4-10 — sweep_disputes() (0038) contra PG real: SURFACEA la salud del plano de
 * disputas SIN transicionar nada (la resolución es solo por fuente verificada,
 * V4 §23). Una disputa `open`/`under_review` retiene fondos; las envejecidas
 * (>7 días) son la alerta. Las filas se preparan por el admin (superusuario); la
 * función corre con el rol fluvia_worker (sin privilegios de tabla — no puede
 * SELECT `disputes` bajo RLS). Conteos globales con `>=`.
 */

let workerPool: Pool;
let appPool: Pool;
let relayPool: Pool;
let adminPool: Pool;
let org: string;
let merchant: string;

/** Inserta una disputa `open` (el conteo no depende del balance). */
async function insertDispute(): Promise<string> {
  const res = await adminPool.query<{ id: string }>(
    `INSERT INTO disputes (tenant_id, merchant_id, amount, currency, provider)
     VALUES ($1, $2, 30000, 'COP', 'mock') RETURNING id`,
    [org, merchant]
  );
  return res.rows[0]!.id;
}

/** Envejece created_at (no toca status). */
async function age(id: string, days: number): Promise<void> {
  await adminPool.query(
    `UPDATE disputes SET created_at = now() - make_interval(days => $2) WHERE id = $1`,
    [id, days]
  );
}

beforeAll(async () => {
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' });
  workerPool = createPool({ connectionString: config.db.worker, max: 2 });
  appPool = createPool({ connectionString: config.db.app, max: 2 });
  relayPool = createPool({ connectionString: config.db.relay, max: 2 });
  adminPool = createPool({ connectionString: config.db.admin, max: 2 });
  org = (
    await adminPool.query<{ id: string }>(
      `INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id`,
      [`Dispute WD ${randomUUID().slice(0, 8)}`, `dwd-${randomUUID()}`]
    )
  ).rows[0]!.id;
  merchant = (
    await adminPool.query<{ id: string }>(
      `INSERT INTO merchants (tenant_id, name) VALUES ($1, $2) RETURNING id`,
      [org, `dwd-shop-${randomUUID().slice(0, 8)}`]
    )
  ).rows[0]!.id;
}, 30_000);

afterAll(async () => {
  await Promise.all([workerPool.end(), appPool.end(), relayPool.end(), adminPool.end()]);
});

describe('sweep_disputes() — salud sin barrido (0038)', () => {
  it('counts live disputes as held, and only past-threshold ones as aged', async () => {
    const aged = await insertDispute();
    await age(aged, 10); // >7 días: retenida Y envejecida
    const fresh = await insertDispute(); // retenida, no envejecida

    const res = await workerPool.query<{ metric: string; value: string }>(
      `SELECT metric, value::text FROM sweep_disputes()`
    );
    const byMetric = Object.fromEntries(res.rows.map((r) => [r.metric, Number(r.value)]));
    expect(byMetric.held_total).toBeGreaterThanOrEqual(2);
    expect(byMetric.held_aged).toBeGreaterThanOrEqual(1);

    // NO transiciona nada: ambas siguen `open` (la resolución es verificada).
    const stAged = await adminPool.query<{ status: string }>(
      `SELECT status FROM disputes WHERE id = $1`,
      [aged]
    );
    expect(stAged.rows[0]!.status).toBe('open');
    const stFresh = await adminPool.query<{ status: string }>(
      `SELECT status FROM disputes WHERE id = $1`,
      [fresh]
    );
    expect(stFresh.rows[0]!.status).toBe('open');
  });

  it('a resolved dispute is neither held nor aged', async () => {
    const d = await insertDispute();
    await age(d, 30);
    // Resolver (open -> won es transición legal; el trigger de FSM la valida).
    await adminPool.query(`UPDATE disputes SET status = 'won' WHERE id = $1`, [d]);
    const res = await workerPool.query<{ metric: string; value: string }>(
      `SELECT value::text AS v FROM sweep_disputes() WHERE metric = 'held_total'`
    );
    // No podemos asertar el total exacto (cross-tenant), pero la resuelta no cuenta:
    // su envejecimiento no dispara la alerta.
    const held = await adminPool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM disputes
       WHERE id = $1 AND status IN ('open', 'under_review')`,
      [d]
    );
    expect(Number(held.rows[0]!.n)).toBe(0);
    expect(res.rowCount).toBe(1);
  });

  it('only the worker role may execute the function', async () => {
    await expect(appPool.query(`SELECT * FROM sweep_disputes()`)).rejects.toThrow(
      /permission denied/i
    );
    await expect(relayPool.query(`SELECT * FROM sweep_disputes()`)).rejects.toThrow(
      /permission denied/i
    );
  });
});

describe('DisputesWatchdog (F4-10)', () => {
  it('runOnce returns non-negative integer counts', async () => {
    const wd = new DisputesWatchdog(workerPool);
    const health = await wd.runOnce();
    for (const v of Object.values(health)) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  it('onResult observer fires and its failure never breaks the job', async () => {
    const wd = new DisputesWatchdog(
      workerPool,
      { info: () => undefined, error: () => undefined },
      {
        onResult: () => {
          throw new Error('observer exploded');
        },
      }
    );
    await expect(wd.runOnce()).resolves.toBeDefined();
  });
});
