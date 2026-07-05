import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@fluvia/config';
import { createPool, type Pool } from '@fluvia/db';
import { TechnicalPurgeJob, type PurgeResultRow } from '../src/purge.js';

let workerPool: Pool;

beforeAll(() => {
  const config = loadConfig({ NODE_ENV: 'test' });
  workerPool = createPool({ connectionString: config.db.worker, max: 2 });
});

afterAll(async () => {
  await workerPool.end();
});

describe('TechnicalPurgeJob (F1-09)', () => {
  it('runOnce reports the 4 technical classes with numeric counts', async () => {
    const job = new TechnicalPurgeJob(workerPool);
    const rows = await job.runOnce();
    expect(rows.map((r) => r.class).sort()).toEqual([
      'email_verification_tokens',
      'idempotency_keys',
      'mfa_challenges',
      'sessions',
    ]);
    for (const row of rows) {
      expect(Number.isInteger(row.purged)).toBe(true);
      expect(row.purged).toBeGreaterThanOrEqual(0);
    }
  });

  it('onResult observer fires per run and its failures never break the job (F1-07)', async () => {
    const seen: PurgeResultRow[][] = [];
    const job = new TechnicalPurgeJob(
      workerPool,
      { info: () => undefined, error: () => undefined },
      {
        onResult: (rows) => {
          seen.push(rows);
          throw new Error('metrics observer exploded');
        },
      }
    );
    const rows = await job.runOnce();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(rows);
  });
});
