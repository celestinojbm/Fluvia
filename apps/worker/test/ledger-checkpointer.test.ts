import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@fluvia/config';
import { createPool, type Pool } from '@fluvia/db';
import { LedgerCheckpointer, type LedgerChainHealth } from '../src/ledger-checkpointer.js';

/**
 * F6 (threat model §5, fila Ledger) — LedgerCheckpointer contra PG real: el
 * job invoca `seal_ledger_checkpoints()` (0042) con el rol fluvia_worker (sin
 * privilegios de tabla; el DEFINER sella por él) y publica los gauges. La
 * SEMÁNTICA del sellado (dos fases, horizonte de txid, detección de tampering)
 * se prueba en packages/db/test/ledger-hash-chain.test.ts — aquí solo el job.
 */

let workerPool: Pool;
let adminPool: Pool;
let org: string;
let acctA: string;
let acctB: string;

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/** Inserta una tx balanceada y devuelve el seq máximo asignado (marcador). */
async function insertBalancedTx(): Promise<number> {
  const client = await adminPool.connect();
  try {
    await client.query('BEGIN');
    const tx = await client.query<{ id: string }>(
      `INSERT INTO ledger_transactions (tenant_id, idempotency_key, reason)
       VALUES ($1, $2, 'adjustment') RETURNING id`,
      [org, `lcp-${randomUUID()}`]
    );
    const r = await client.query<{ n: string }>(
      `INSERT INTO ledger_entries (tenant_id, tx_root_id, account_id, direction, amount, currency, reason)
       VALUES ($1, $2, $3, 'debit', 4200, 'USD', 'adjustment'),
              ($1, $2, $4, 'credit', 4200, 'USD', 'adjustment')
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

beforeAll(async () => {
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' });
  workerPool = createPool({ connectionString: config.db.worker, max: 2 });
  adminPool = createPool({ connectionString: config.db.admin, max: 2 });
  org = (
    await adminPool.query<{ id: string }>(
      `INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id`,
      [`Ledger CP ${randomUUID().slice(0, 8)}`, `lcp-${randomUUID()}`]
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
  acctA = await mkAccount('lcp-clearing', 'debit');
  acctB = await mkAccount('lcp-merchant', 'credit');
}, 30_000);

afterAll(async () => {
  await Promise.all([workerPool.end(), adminPool.end()]);
});

describe('LedgerCheckpointer — sellado del hash-chain con rol worker (F6)', () => {
  it('seals pending entries through the DEFINER function and reports the gauges', async () => {
    const seq = await insertBalancedTx();
    const seen: LedgerChainHealth[] = [];
    const job = new LedgerCheckpointer(workerPool, undefined, {
      minCandidateAgeMs: 0,
      onResult: (health) => seen.push(health),
    });

    // Dos fases por diseño (candidato → finalización); ADEMÁS
    // ledger-chain-anchorer.test.ts corre en paralelo y también sella, así que un
    // candidato puede AGRUPAR ambas txs y un SOLO finalize (de cualquiera de los
    // dos) las cubre. Por eso se espera al estado ACUMULADO `sealedUptoSeq >= seq`
    // (robusto a QUIÉN selló + al horizonte de txid de otra suite con una tx
    // abierta), no a `sealedThisRun === 1` de ESTA llamada — que inanicionaría al
    // perdedor del finalize. Cota dura + backoff → FAIL claro, jamás falso verde.
    let sealed: LedgerChainHealth | undefined;
    for (let i = 0; i < 240 && !sealed; i += 1) {
      const health = await job.runOnce();
      if (health.sealedUptoSeq >= seq) sealed = health;
      else await sleep(25);
    }
    expect(sealed, 'la cadena nunca cubrió la tx sembrada').toBeDefined();
    expect(sealed!.checkpointsTotal).toBeGreaterThanOrEqual(1);
    expect(sealed!.sealedUptoSeq).toBeGreaterThanOrEqual(seq);
    // El rezago de detección se expone (gauge de estancamiento); nunca negativo.
    expect(typeof sealed!.unsealedSeq).toBe('number');
    expect(sealed!.unsealedSeq).toBeGreaterThanOrEqual(0);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toEqual(sealed);

    job.stop();
  }, 30_000);

  it('a metrics observer that throws never breaks the job run', async () => {
    const job = new LedgerCheckpointer(workerPool, undefined, {
      minCandidateAgeMs: 0,
      onResult: () => {
        throw new Error('observer boom');
      },
    });
    await expect(job.runOnce()).resolves.toBeTruthy();
    job.stop();
  });
});
