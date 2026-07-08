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

async function insertBalancedTx(): Promise<void> {
  const client = await adminPool.connect();
  try {
    await client.query('BEGIN');
    const tx = await client.query<{ id: string }>(
      `INSERT INTO ledger_transactions (tenant_id, idempotency_key, reason)
       VALUES ($1, $2, 'adjustment') RETURNING id`,
      [org, `lcp-${randomUUID()}`]
    );
    await client.query(
      `INSERT INTO ledger_entries (tenant_id, tx_root_id, account_id, direction, amount, currency, reason)
       VALUES ($1, $2, $3, 'debit', 4200, 'USD', 'adjustment'),
              ($1, $2, $4, 'credit', 4200, 'USD', 'adjustment')`,
      [org, tx.rows[0]!.id, acctA, acctB]
    );
    await client.query('COMMIT');
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
    await insertBalancedTx();
    const seen: LedgerChainHealth[] = [];
    const job = new LedgerCheckpointer(workerPool, undefined, {
      minCandidateAgeMs: 0,
      onResult: (health) => seen.push(health),
    });

    // Dos fases por diseño (candidato → finalización); otras suites pueden
    // tener una tx abierta que retrase la fase 2 (horizonte de txid), así que
    // se itera hasta observar un sellado — jamás un falso verde.
    let sealed: LedgerChainHealth | undefined;
    for (let i = 0; i < 50 && !sealed; i += 1) {
      const health = await job.runOnce();
      if (health.sealedThisRun === 1) sealed = health;
    }
    expect(sealed, 'el job nunca llegó a sellar un checkpoint').toBeDefined();
    expect(sealed!.checkpointsTotal).toBeGreaterThanOrEqual(1);
    expect(sealed!.sealedUptoSeq).toBeGreaterThan(0);
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
