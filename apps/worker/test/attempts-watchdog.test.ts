import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@fluvia/config';
import { createPool, type Pool } from '@fluvia/db';
import { AttemptsWatchdog, type AttemptsHealth } from '../src/attempts-watchdog.js';

let workerPool: Pool;

beforeAll(() => {
  const config = loadConfig({ NODE_ENV: 'test' });
  workerPool = createPool({ connectionString: config.db.worker, max: 2 });
});

afterAll(async () => {
  await workerPool.end();
});

describe('AttemptsWatchdog (F3-04)', () => {
  it('runOnce reports the three health metrics as numbers', async () => {
    const wd = new AttemptsWatchdog(workerPool);
    const health = await wd.runOnce();
    for (const v of Object.values(health)) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  it('onResult observer fires per run and its failures never break the job (F1-07)', async () => {
    const seen: AttemptsHealth[] = [];
    const wd = new AttemptsWatchdog(
      workerPool,
      { info: () => undefined, error: () => undefined },
      {
        onResult: (health) => {
          seen.push(health);
          throw new Error('metrics observer exploded');
        },
      }
    );
    const health = await wd.runOnce();
    expect(seen).toEqual([health]);
  });
});
