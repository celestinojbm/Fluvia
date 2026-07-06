import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@fluvia/config';
import { createPool, type Pool } from '@fluvia/db';
import { PayoutsWatchdog } from '../src/payouts-watchdog.js';

/**
 * F4-07c — sweep_payouts() (0034) contra PG real: un payout atascado en
 * `in_transit` mas alla del lease se barre a `indeterminate` (desenlace del
 * banco desconocido, fondos retenidos), jamas failed por asuncion (V4 §23). Las
 * filas se preparan por el admin (superusuario); el barrido corre con el rol
 * fluvia_worker (sin privilegios de tabla). Se asserta por FILA + auditoria; los
 * conteos globales (indeterminate_total/aged) se comprueban con `>=`.
 */

let workerPool: Pool;
let appPool: Pool;
let relayPool: Pool;
let adminPool: Pool;
let org: string;
let merchant: string;

async function insertPayout(): Promise<string> {
  const res = await adminPool.query<{ id: string }>(
    `INSERT INTO payouts (tenant_id, merchant_id, amount, currency, provider)
     VALUES ($1, $2, 50000, 'COP', 'mock') RETURNING id`,
    [org, merchant]
  );
  return res.rows[0]!.id;
}

/** requested -> in_transit (transicion legal), con updated_at envejecido. */
async function stuckInTransit(ageMinutes: number): Promise<string> {
  const id = await insertPayout();
  await adminPool.query(`UPDATE payouts SET status = 'in_transit' WHERE id = $1`, [id]);
  // UPDATE de columna no-status: el trigger de FSM no interviene.
  await adminPool.query(
    `UPDATE payouts SET updated_at = now() - make_interval(mins => $2) WHERE id = $1`,
    [id, ageMinutes]
  );
  return id;
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
      [`Payout WD ${randomUUID().slice(0, 8)}`, `pwd-${randomUUID()}`]
    )
  ).rows[0]!.id;
  merchant = (
    await adminPool.query<{ id: string }>(
      `INSERT INTO merchants (tenant_id, name) VALUES ($1, $2) RETURNING id`,
      [org, `pwd-shop-${randomUUID().slice(0, 8)}`]
    )
  ).rows[0]!.id;
}, 30_000);

afterAll(async () => {
  await Promise.all([workerPool.end(), appPool.end(), relayPool.end(), adminPool.end()]);
});

describe('sweep_payouts() — barrido y salud (0034)', () => {
  it('sweeps ONLY past-lease in_transit payouts to indeterminate, with atomic audit', async () => {
    const stale = await stuckInTransit(10);
    const fresh = await stuckInTransit(1);

    const res = await workerPool.query<{ metric: string; value: string }>(
      `SELECT metric, value::text FROM sweep_payouts()`
    );
    const byMetric = Object.fromEntries(res.rows.map((r) => [r.metric, Number(r.value)]));
    expect(byMetric.swept_to_indeterminate).toBeGreaterThanOrEqual(1);
    expect(byMetric.indeterminate_total).toBeGreaterThanOrEqual(1);

    const staleRow = await adminPool.query<{ status: string; failure_code: string | null }>(
      `SELECT status, failure_code FROM payouts WHERE id = $1`,
      [stale]
    );
    expect(staleRow.rows[0]!.status).toBe('indeterminate');
    // Barrido NO fija failure_code (no es un fallo): el rastro vive en la auditoria.
    expect(staleRow.rows[0]!.failure_code).toBeNull();
    // El fresco sigue en in_transit: el lease manda.
    const freshRow = await adminPool.query<{ status: string }>(
      `SELECT status FROM payouts WHERE id = $1`,
      [fresh]
    );
    expect(freshRow.rows[0]!.status).toBe('in_transit');

    // Auditoria atomica con los ids barridos.
    const audit = await adminPool.query<{ after_summary: { payout_ids: string[] } }>(
      `SELECT after_summary FROM audit_events
       WHERE action = 'payout.swept_indeterminate'
       ORDER BY id DESC LIMIT 1`
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0]!.after_summary.payout_ids).toContain(stale);
  });

  it('aged indeterminate payouts are counted for the baseline alert', async () => {
    const aged = await stuckInTransit(10);
    await workerPool.query(`SELECT * FROM sweep_payouts()`); // aged -> indeterminate
    await adminPool.query(
      `UPDATE payouts SET updated_at = now() - interval '45 minutes' WHERE id = $1`,
      [aged]
    );
    const res = await workerPool.query<{ metric: string; value: string }>(
      `SELECT metric, value::text FROM sweep_payouts()`
    );
    const byMetric = Object.fromEntries(res.rows.map((r) => [r.metric, Number(r.value)]));
    expect(byMetric.indeterminate_aged).toBeGreaterThanOrEqual(1);
  });

  it('stuck `requested` payouts (execute never ran) are surfaced, not moved', async () => {
    const id = await insertPayout();
    await adminPool.query(
      `UPDATE payouts SET created_at = now() - interval '10 minutes' WHERE id = $1`,
      [id]
    );
    const res = await workerPool.query<{ metric: string; value: string }>(
      `SELECT metric, value::text FROM sweep_payouts()`
    );
    const byMetric = Object.fromEntries(res.rows.map((r) => [r.metric, Number(r.value)]));
    expect(byMetric.requested_stuck).toBeGreaterThanOrEqual(1);
    // Se SURFACEA, no se toca: sigue en requested (sin dinero en riesgo).
    const row = await adminPool.query<{ status: string }>(
      `SELECT status FROM payouts WHERE id = $1`,
      [id]
    );
    expect(row.rows[0]!.status).toBe('requested');
  });

  it('only the worker role may execute the sweep', async () => {
    await expect(appPool.query(`SELECT * FROM sweep_payouts()`)).rejects.toThrow(
      /permission denied/i
    );
    await expect(relayPool.query(`SELECT * FROM sweep_payouts()`)).rejects.toThrow(
      /permission denied/i
    );
  });
});

describe('PayoutsWatchdog (F4-07c)', () => {
  it('runOnce returns non-negative integer counts', async () => {
    const wd = new PayoutsWatchdog(workerPool);
    const health = await wd.runOnce();
    for (const v of Object.values(health)) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  it('onResult observer fires and its failure never breaks the job', async () => {
    const wd = new PayoutsWatchdog(
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
