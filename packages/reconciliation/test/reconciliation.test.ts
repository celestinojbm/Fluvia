import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '@fluvia/db/testing';
import {
  ReconciliationService,
  ReportAlreadyReconciledError,
  SettlementReportNotFoundError,
} from '../src/index.js';

/**
 * F4-01a — motor de conciliación contra PG real. Se siembran intentos
 * `succeeded` (lado ledger) con el pool admin y líneas de liquidación (lado
 * proveedor) por el servicio; el motor clasifica cada referencia.
 */

let ctx: TestContext;
let service: ReconciliationService;
let org: string;
let merchant: string;

const PERIOD_START = new Date('2026-06-01T00:00:00Z');
const PERIOD_END = new Date('2026-07-01T00:00:00Z');
const IN_PERIOD = new Date('2026-06-15T12:00:00Z');
const OUT_OF_PERIOD = new Date('2026-05-15T12:00:00Z');

async function seedSucceededAttempt(
  providerRef: string,
  amount: number,
  resolvedAt: Date,
  currency = 'COP'
): Promise<void> {
  const intent = (
    await ctx.admin.query<{ id: string }>(
      `INSERT INTO payment_intents
         (tenant_id, merchant_id, amount, currency, status, capture_method, amount_captured, succeeded_at)
       VALUES ($1, $2, $3, $4, 'succeeded', 'automatic', $3, $5) RETURNING id`,
      [org, merchant, amount, currency, resolvedAt]
    )
  ).rows[0]!.id;
  await ctx.admin.query(
    `INSERT INTO payment_attempts
       (tenant_id, intent_id, attempt_number, provider, provider_ref, status, amount, currency, resolved_at)
     VALUES ($1, $2, 1, 'mock', $3, 'succeeded', $4, $5, $6)`,
    [org, intent, providerRef, amount, currency, resolvedAt]
  );
}

beforeAll(async () => {
  ctx = await createTestContext();
  service = new ReconciliationService(ctx.app);
  org = await ctx.createTenant(`RECON ${randomUUID().slice(0, 8)}`);
  merchant = (
    await ctx.admin.query<{ id: string }>(
      'INSERT INTO merchants (tenant_id, name) VALUES ($1, $2) RETURNING id',
      [org, `recon-shop-${randomUUID().slice(0, 8)}`]
    )
  ).rows[0]!.id;
}, 30_000);

afterAll(async () => {
  await ctx.close();
});

describe('conciliación', () => {
  it('classifies matched / amount_mismatch / missing_in_ledger / missing_at_provider', async () => {
    // Lado ledger (intentos succeeded del proveedor 'mock', en periodo).
    await seedSucceededAttempt('ref_match', 50_000, IN_PERIOD);
    await seedSucceededAttempt('ref_mismatch', 30_000, IN_PERIOD);
    await seedSucceededAttempt('ref_only_ledger', 20_000, IN_PERIOD);
    // Fuera de periodo: NO debe entrar en la conciliación.
    await seedSucceededAttempt('ref_out_of_period', 99_000, OUT_OF_PERIOD);

    const report = await service.createReport(org, {
      provider: 'mock',
      currency: 'COP',
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    });
    // Lado proveedor.
    await service.addLines(org, report.id, [
      { providerRef: 'ref_match', amount: 50_000n, settledAt: IN_PERIOD },
      { providerRef: 'ref_mismatch', amount: 29_000n, settledAt: IN_PERIOD }, // difiere
      { providerRef: 'ref_only_provider', amount: 15_000n, settledAt: IN_PERIOD },
    ]);

    const summary = await service.reconcile(org, report.id);
    expect(summary).toEqual({
      matched: 1,
      amount_mismatch: 1,
      missing_at_provider: 1, // ref_only_ledger
      missing_in_ledger: 1, // ref_only_provider
    });

    // El reporte quedó 'reconciled'.
    expect((await service.getReport(org, report.id)).status).toBe('reconciled');

    // Detalle del amount_mismatch: ambos montos presentes.
    const mismatches = await service.listEntries(org, report.id, { status: 'amount_mismatch' });
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]!.providerRef).toBe('ref_mismatch');
    expect(mismatches[0]!.ledgerAmount).toBe('30000');
    expect(mismatches[0]!.providerAmount).toBe('29000');

    // El de fuera de periodo no aparece.
    const all = await service.listEntries(org, report.id, { limit: 500 });
    expect(all.map((e) => e.providerRef)).not.toContain('ref_out_of_period');
  });

  it('addLines is idempotent per (report, provider_ref)', async () => {
    const report = await service.createReport(org, {
      provider: 'mock',
      currency: 'COP',
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    });
    const first = await service.addLines(org, report.id, [
      { providerRef: 'dup', amount: 1000n, settledAt: IN_PERIOD },
    ]);
    const second = await service.addLines(org, report.id, [
      { providerRef: 'dup', amount: 1000n, settledAt: IN_PERIOD },
    ]);
    expect(first).toBe(1);
    expect(second).toBe(0);
  });

  it('refuses to reconcile a report twice (append-only run)', async () => {
    const report = await service.createReport(org, {
      provider: 'mock',
      currency: 'COP',
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    });
    await service.reconcile(org, report.id);
    await expect(service.reconcile(org, report.id)).rejects.toBeInstanceOf(
      ReportAlreadyReconciledError
    );
  });

  it('isolates by tenant', async () => {
    const other = await ctx.createTenant(`RECON-B ${randomUUID().slice(0, 8)}`);
    const report = await service.createReport(org, {
      provider: 'mock',
      currency: 'COP',
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    });
    await expect(service.getReport(other, report.id)).rejects.toBeInstanceOf(
      SettlementReportNotFoundError
    );
  });
});
