import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '@fluvia/config';
import { createPool, type Pool } from '@fluvia/db';
import { WorkerProcess, type WorkerLogger } from '../src/worker.js';

const silentLogger: WorkerLogger = { info: () => undefined, error: () => undefined };
let workerPool: Pool;

beforeAll(() => {
  const config = loadConfig({ NODE_ENV: 'test' });
  workerPool = createPool({ connectionString: config.db.worker, max: 2 });
});

afterAll(async () => {
  await workerPool.end();
});

describe('WorkerProcess (F1-01)', () => {
  it('checkReady succeeds against the real database with the worker role', async () => {
    const worker = new WorkerProcess({ pool: workerPool, logger: silentLogger });
    await expect(worker.checkReady()).resolves.toBeUndefined();
    await worker.stop();
  });

  it('checkReady fails fast when the database is unreachable', async () => {
    const deadPool = createPool({ connectionString: 'postgres://x:x@127.0.0.1:1/none', max: 1 });
    const worker = new WorkerProcess({ pool: deadPool, logger: silentLogger });
    await expect(worker.checkReady()).rejects.toThrow();
    await worker.stop();
    await deadPool.end();
  });

  it('emits heartbeats while running and stops cleanly', async () => {
    vi.useFakeTimers();
    try {
      const worker = new WorkerProcess({
        pool: workerPool,
        logger: silentLogger,
        heartbeatIntervalMs: 100,
      });
      worker.start();
      await vi.advanceTimersByTimeAsync(350);
      expect(worker.heartbeats).toBeGreaterThanOrEqual(3);
      await worker.stop();
      const after = worker.heartbeats;
      await vi.advanceTimersByTimeAsync(500);
      expect(worker.heartbeats).toBe(after);
    } finally {
      vi.useRealTimers();
    }
  });

  it('start is idempotent (double start does not double the heartbeat rate)', async () => {
    vi.useFakeTimers();
    try {
      const worker = new WorkerProcess({
        pool: workerPool,
        logger: silentLogger,
        heartbeatIntervalMs: 100,
      });
      worker.start();
      worker.start();
      await vi.advanceTimersByTimeAsync(250);
      expect(worker.heartbeats).toBe(2);
      await worker.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
