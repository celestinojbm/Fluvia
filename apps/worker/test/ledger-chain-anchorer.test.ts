import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@fluvia/config';
import { createPool, type Pool } from '@fluvia/db';
import { LedgerChainAnchorer, type LedgerAnchorHealth } from '../src/ledger-chain-anchorer.js';

/**
 * F6 (threat model §5, fila Ledger) — LedgerChainAnchorer contra PG real: el job
 * invoca `anchor_ledger_chain()` (0043) con el rol fluvia_worker (sin privilegios
 * de tabla; el DEFINER ancla por él) y publica los gauges. La SEMÁNTICA del
 * anclaje y la detección de truncado/borrado se prueban vía el script [8] en
 * packages/db/test/ledger-hash-chain.test.ts — aquí solo el job.
 */

let workerPool: Pool;
let adminPool: Pool;
let org: string;
let acctA: string;
let acctB: string;

/** Inserta una tx balanceada y devuelve el seq máximo asignado (marcador). */
async function insertBalancedTx(): Promise<number> {
  const client = await adminPool.connect();
  try {
    await client.query('BEGIN');
    const tx = await client.query<{ id: string }>(
      `INSERT INTO ledger_transactions (tenant_id, idempotency_key, reason)
       VALUES ($1, $2, 'adjustment') RETURNING id`,
      [org, `lca-${randomUUID()}`]
    );
    const r = await client.query<{ n: string }>(
      `INSERT INTO ledger_entries (tenant_id, tx_root_id, account_id, direction, amount, currency, reason)
       VALUES ($1, $2, $3, 'debit', 5100, 'USD', 'adjustment'),
              ($1, $2, $4, 'credit', 5100, 'USD', 'adjustment')
       RETURNING seq::text AS n`,
      [org, tx.rows[0]!.id, acctA, acctB]
    );
    await client.query('COMMIT');
    return Math.max(...r.rows.map((row) => Number(row.n)));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/**
 * Sella (dos fases) hasta que la cadena cubra `seq` — sin importar QUIÉN selló
 * (ledger-checkpointer.test.ts corre en paralelo y puede sellar el mismo tip
 * global). Backoff acotado robusto al horizonte de txid de otras suites; cota
 * dura → FAIL claro, jamás cuelgue ni falso verde.
 */
async function sealUntilCovers(seq: number): Promise<void> {
  for (let i = 0; i < 240; i += 1) {
    const res = await adminPool.query<{ metric: string; value: string }>(
      `SELECT metric, value::text FROM seal_ledger_checkpoints(interval '0')`
    );
    const m = Object.fromEntries(res.rows.map((r) => [r.metric, Number(r.value)]));
    if ((m.sealed_upto_seq ?? 0) >= seq) return;
    await sleep(25);
  }
  throw new Error(`la cadena no selló hasta seq ${seq}`);
}

beforeAll(async () => {
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' });
  workerPool = createPool({ connectionString: config.db.worker, max: 2 });
  adminPool = createPool({ connectionString: config.db.admin, max: 2 });
  org = (
    await adminPool.query<{ id: string }>(
      `INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id`,
      [`Ledger Anchor ${randomUUID().slice(0, 8)}`, `lca-${randomUUID()}`]
    )
  ).rows[0]!.id;
  const mkAccount = async (name: string, side: 'debit' | 'credit') =>
    (
      await adminPool.query<{ id: string }>(
        `INSERT INTO ledger_accounts (tenant_id, name, currency, normal_side)
         VALUES ($1, $2, 'USD', $3) RETURNING id`,
        [org, `${name}-${randomUUID().slice(0, 8)}`, side]
      )
    ).rows[0]!.id;
  acctA = await mkAccount('lca-clearing', 'debit');
  acctB = await mkAccount('lca-merchant', 'credit');
}, 30_000);

afterAll(async () => {
  await Promise.all([workerPool.end(), adminPool.end()]);
});

describe('LedgerChainAnchorer — anclaje externo del chain_hash con rol worker (F6)', () => {
  it('anchors the sealed tip through the DEFINER function and reports the gauges', async () => {
    const seq = await insertBalancedTx();
    await sealUntilCovers(seq);

    const seen: LedgerAnchorHealth[] = [];
    const job = new LedgerChainAnchorer(workerPool, undefined, {
      onResult: (health) => seen.push(health),
    });

    const health = await job.runOnce();
    expect(health.anchorsTotal).toBeGreaterThanOrEqual(1);
    expect(health.anchoredUptoSeq).toBeGreaterThan(0);
    expect(typeof health.anchoredThisRun).toBe('number');
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toEqual(health);

    job.stop();
  }, 30_000);

  // La idempotencia/monotonía del anclaje (re-anclar el mismo tip = no-op) se
  // prueba de forma determinista en packages/db/test/ledger-hash-chain.test.ts,
  // donde el sellado está bajo control secuencial; aquí ledger-checkpointer corre
  // en paralelo y puede avanzar el tip entre corridas.

  it('a metrics observer that throws never breaks the job run', async () => {
    const job = new LedgerChainAnchorer(workerPool, undefined, {
      onResult: () => {
        throw new Error('observer boom');
      },
    });
    await expect(job.runOnce()).resolves.toBeTruthy();
    job.stop();
  });
});
