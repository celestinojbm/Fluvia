import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@fluvia/config';
import { createPool, type Pool } from '@fluvia/db';
import { ReconciliationService } from '@fluvia/reconciliation';
import {
  ReconciliationWatchdog,
  discrepancyCount,
  type ReconciliationSweepResult,
} from '../src/reconciliation-watchdog.js';

/**
 * F4-02 — el barrido continuo de conciliación: concilia cross-tenant los
 * reportes con periodo cerrado (`open` + `period_end <= now()`) invocando
 * sweep_settlement_reports() con el rol fluvia_worker (sin privilegios de
 * tabla). Se asserta por reporte (getSummary/getReport bajo RLS), no por
 * conteos globales del barrido, que dependen del resto de la suite.
 */

let workerPool: Pool;
let appPool: Pool;
let adminPool: Pool;
let service: ReconciliationService;

// Periodo YA CERRADO: period_end en el pasado -> lo barre el watchdog.
const CLOSED_START = new Date('2020-01-01T00:00:00Z');
const CLOSED_END = new Date('2020-02-01T00:00:00Z');
const CLOSED_IN = new Date('2020-01-15T12:00:00Z');

async function newTenant(label: string): Promise<string> {
  return adminPool
    .query<{ id: string }>(`INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id`, [
      `${label} ${randomUUID().slice(0, 8)}`,
      `${label.toLowerCase()}-${randomUUID()}`,
    ])
    .then((r) => r.rows[0]!.id);
}

async function newMerchant(org: string): Promise<string> {
  return adminPool
    .query<{ id: string }>(`INSERT INTO merchants (tenant_id, name) VALUES ($1, $2) RETURNING id`, [
      org,
      `rw-shop-${randomUUID().slice(0, 8)}`,
    ])
    .then((r) => r.rows[0]!.id);
}

async function seedSucceededAttempt(
  org: string,
  merchant: string,
  providerRef: string,
  amount: number,
  resolvedAt: Date,
  currency = 'COP'
): Promise<void> {
  const intent = (
    await adminPool.query<{ id: string }>(
      `INSERT INTO payment_intents
         (tenant_id, merchant_id, amount, currency, status, capture_method, amount_captured, succeeded_at)
       VALUES ($1, $2, $3, $4, 'succeeded', 'automatic', $3, $5) RETURNING id`,
      [org, merchant, amount, currency, resolvedAt]
    )
  ).rows[0]!.id;
  await adminPool.query(
    `INSERT INTO payment_attempts
       (tenant_id, intent_id, attempt_number, provider, provider_ref, status, amount, currency, resolved_at)
     VALUES ($1, $2, 1, 'mock', $3, 'succeeded', $4, $5, $6)`,
    [org, intent, providerRef, amount, currency, resolvedAt]
  );
}

beforeAll(async () => {
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' });
  workerPool = createPool({ connectionString: config.db.worker, max: 2 });
  appPool = createPool({ connectionString: config.db.app, max: 4 });
  adminPool = createPool({ connectionString: config.db.admin, max: 2 });
  service = new ReconciliationService(appPool);
}, 30_000);

afterAll(async () => {
  await Promise.all([workerPool.end(), appPool.end(), adminPool.end()]);
});

describe('ReconciliationWatchdog (F4-02)', () => {
  it('runOnce returns non-negative integer counts', async () => {
    const wd = new ReconciliationWatchdog(workerPool);
    const r = await wd.runOnce();
    for (const v of Object.values(r)) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  it('reconciles a sealed report cross-tenant and classifies every reference', async () => {
    const org = await newTenant('RW');
    const merchant = await newMerchant(org);
    // Lado ledger (intentos succeeded 'mock', dentro del periodo cerrado).
    await seedSucceededAttempt(org, merchant, 'rw_match', 50_000, CLOSED_IN);
    await seedSucceededAttempt(org, merchant, 'rw_mismatch', 30_000, CLOSED_IN);
    await seedSucceededAttempt(org, merchant, 'rw_only_ledger', 20_000, CLOSED_IN);

    const report = await service.createReport(org, {
      provider: 'mock',
      currency: 'COP',
      periodStart: CLOSED_START,
      periodEnd: CLOSED_END,
    });
    await service.addLines(org, report.id, [
      { providerRef: 'rw_match', amount: 50_000n, settledAt: CLOSED_IN },
      { providerRef: 'rw_mismatch', amount: 29_000n, settledAt: CLOSED_IN }, // difiere
      { providerRef: 'rw_only_provider', amount: 15_000n, settledAt: CLOSED_IN },
    ]);

    await new ReconciliationWatchdog(workerPool).runOnce();

    // El reporte quedó conciliado por el barrido (no lo tocamos a mano).
    expect((await service.getReport(org, report.id)).status).toBe('reconciled');
    expect(await service.getSummary(org, report.id)).toEqual({
      matched: 1,
      amount_mismatch: 1,
      missing_at_provider: 1, // rw_only_ledger
      missing_in_ledger: 1, // rw_only_provider
    });
  });

  it('leaves an OPEN period untouched (period_end still in the future)', async () => {
    const org = await newTenant('RW-OPEN');
    const merchant = await newMerchant(org);
    const future = new Date(Date.now() + 365 * 24 * 3600 * 1000);
    const report = await service.createReport(org, {
      provider: 'mock',
      currency: 'COP',
      periodStart: CLOSED_START,
      periodEnd: future,
    });
    await seedSucceededAttempt(org, merchant, 'rw_future', 10_000, CLOSED_IN);
    await service.addLines(org, report.id, [
      { providerRef: 'rw_future', amount: 10_000n, settledAt: CLOSED_IN },
    ]);

    await new ReconciliationWatchdog(workerPool).runOnce();

    // Periodo aún abierto: el barrido no lo sella ni produce entries.
    expect((await service.getReport(org, report.id)).status).toBe('open');
    expect(await service.getSummary(org, report.id)).toEqual({
      matched: 0,
      amount_mismatch: 0,
      missing_in_ledger: 0,
      missing_at_provider: 0,
    });
  });

  it('is idempotent: a reconciled report is not re-swept nor duplicated', async () => {
    const org = await newTenant('RW-IDEM');
    const merchant = await newMerchant(org);
    await seedSucceededAttempt(org, merchant, 'rw_idem', 7_000, CLOSED_IN);
    const report = await service.createReport(org, {
      provider: 'mock',
      currency: 'COP',
      periodStart: CLOSED_START,
      periodEnd: CLOSED_END,
    });
    await service.addLines(org, report.id, [
      { providerRef: 'rw_idem', amount: 7_000n, settledAt: CLOSED_IN },
    ]);

    await new ReconciliationWatchdog(workerPool).runOnce();
    const first = await service.listEntries(org, report.id, { limit: 500 });
    // Segundo barrido: el reporte ya no está `open`, no re-concilia (guard status).
    await new ReconciliationWatchdog(workerPool).runOnce();
    const second = await service.listEntries(org, report.id, { limit: 500 });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect((await service.getReport(org, report.id)).status).toBe('reconciled');
  });

  it('discrepancyCount sums the non-matched classes', () => {
    const r: ReconciliationSweepResult = {
      reportsReconciled: 1,
      matched: 3,
      amountMismatch: 2,
      missingInLedger: 1,
      missingAtProvider: 4,
    };
    expect(discrepancyCount(r)).toBe(7);
  });

  it('onResult observer fires and its failure never breaks the job', async () => {
    const wd = new ReconciliationWatchdog(
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
