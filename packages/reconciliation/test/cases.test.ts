import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditContext } from '@fluvia/audit';
import { createTestContext, type TestContext } from '@fluvia/db/testing';
import {
  InvalidCaseTransitionError,
  OperationalCaseNotFoundError,
  OperationalCaseService,
  ReconciliationService,
} from '../src/index.js';

/**
 * F4-03a — casos operativos: el trigger 0029 materializa un caso por cada
 * discrepancia (entry != matched) al conciliar; el servicio gobierna el ciclo
 * (acknowledge/resolve) con auditoría. Resolver es DOCUMENTAL, no mueve dinero.
 */

let ctx: TestContext;
let reconciliation: ReconciliationService;
let cases: OperationalCaseService;
let org: string;
let merchant: string;

const PERIOD_START = new Date('2026-06-01T00:00:00Z');
const PERIOD_END = new Date('2026-07-01T00:00:00Z');
const IN_PERIOD = new Date('2026-06-15T12:00:00Z');

const apiKeyCtx: AuditContext = {
  actorType: 'api_key',
  actorId: randomUUID(),
  authMethod: 'api_key',
};
const userCtx: AuditContext = { actorType: 'user', actorId: randomUUID(), authMethod: 'session' };

async function seedSucceededAttempt(providerRef: string, amount: number): Promise<void> {
  const intent = (
    await ctx.admin.query<{ id: string }>(
      `INSERT INTO payment_intents
         (tenant_id, merchant_id, amount, currency, status, capture_method, amount_captured, succeeded_at)
       VALUES ($1, $2, $3, 'COP', 'succeeded', 'automatic', $3, $4) RETURNING id`,
      [org, merchant, amount, IN_PERIOD]
    )
  ).rows[0]!.id;
  await ctx.admin.query(
    `INSERT INTO payment_attempts
       (tenant_id, intent_id, attempt_number, provider, provider_ref, status, amount, currency, resolved_at)
     VALUES ($1, $2, 1, 'mock', $3, 'succeeded', $4, 'COP', $5)`,
    [org, intent, providerRef, amount, IN_PERIOD]
  );
}

/** Concilia un reporte con las 4 clases: 1 matched + 3 discrepancias. */
async function reconcileWithDiscrepancies(): Promise<string> {
  await seedSucceededAttempt(`match-${randomUUID().slice(0, 6)}`, 50_000);
  await seedSucceededAttempt(`mismatch-${randomUUID().slice(0, 6)}`, 30_000);
  await seedSucceededAttempt(`onlyledger-${randomUUID().slice(0, 6)}`, 20_000);
  const report = await reconciliation.createReport(org, {
    provider: 'mock',
    currency: 'COP',
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
  });
  return report.id;
}

beforeAll(async () => {
  ctx = await createTestContext();
  reconciliation = new ReconciliationService(ctx.app);
  cases = new OperationalCaseService(ctx.app);
  org = await ctx.createTenant(`CASES ${randomUUID().slice(0, 8)}`);
  merchant = (
    await ctx.admin.query<{ id: string }>(
      'INSERT INTO merchants (tenant_id, name) VALUES ($1, $2) RETURNING id',
      [org, `cases-shop-${randomUUID().slice(0, 8)}`]
    )
  ).rows[0]!.id;
}, 30_000);

afterAll(async () => {
  await ctx.close();
});

describe('materialización de casos', () => {
  it('creates one case per discrepancy (matched entries produce none) with severity mapping', async () => {
    const matchRef = `m-${randomUUID().slice(0, 8)}`;
    const mismatchRef = `x-${randomUUID().slice(0, 8)}`;
    const onlyLedgerRef = `l-${randomUUID().slice(0, 8)}`;
    const onlyProviderRef = `p-${randomUUID().slice(0, 8)}`;
    await seedSucceededAttempt(matchRef, 50_000);
    await seedSucceededAttempt(mismatchRef, 30_000);
    await seedSucceededAttempt(onlyLedgerRef, 20_000);
    const report = await reconciliation.createReport(org, {
      provider: 'mock',
      currency: 'COP',
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    });
    await reconciliation.addLines(org, report.id, [
      { providerRef: matchRef, amount: 50_000n, settledAt: IN_PERIOD },
      { providerRef: mismatchRef, amount: 29_000n, settledAt: IN_PERIOD },
      { providerRef: onlyProviderRef, amount: 15_000n, settledAt: IN_PERIOD },
    ]);

    await reconciliation.reconcile(org, report.id);

    const list = await cases.list(org, { limit: 200 });
    const forReport = list.filter((c) => c.reportId === report.id);
    // 3 discrepancias, 0 por el matched.
    expect(forReport).toHaveLength(3);
    const byRef = Object.fromEntries(forReport.map((c) => [c.providerRef, c]));
    expect(byRef[mismatchRef]!.discrepancyStatus).toBe('amount_mismatch');
    expect(byRef[mismatchRef]!.severity).toBe('high');
    expect(byRef[mismatchRef]!.ledgerAmount).toBe('30000');
    expect(byRef[mismatchRef]!.providerAmount).toBe('29000');
    expect(byRef[onlyProviderRef]!.discrepancyStatus).toBe('missing_in_ledger');
    expect(byRef[onlyProviderRef]!.severity).toBe('critical');
    expect(byRef[onlyLedgerRef]!.discrepancyStatus).toBe('missing_at_provider');
    expect(byRef[onlyLedgerRef]!.severity).toBe('high');
    expect(byRef[matchRef]).toBeUndefined();
    // Todos arrancan 'open', evidencia enlazada a la entry.
    for (const c of forReport) {
      expect(c.status).toBe('open');
      expect(c.reconciliationEntryId).toBeTruthy();
      expect(c.caseType).toBe('reconciliation_discrepancy');
    }
  });
});

describe('ciclo de vida', () => {
  it('acknowledge (open→acknowledged) then resolve (→resolved) with mandatory note + audit', async () => {
    const reportId = await reconcileWithDiscrepancies();
    await reconciliation.reconcile(org, reportId);
    const target = (await cases.list(org, { limit: 200 })).find((c) => c.reportId === reportId)!;
    expect(target.status).toBe('open');

    const acked = await cases.acknowledge(org, target.id, userCtx);
    expect(acked.status).toBe('acknowledged');
    expect(acked.acknowledgedAt).not.toBeNull();
    expect(acked.assigneeUserId).toBe(userCtx.actorId); // user actor se persiste
    expect(acked.version).toBe(target.version + 1);

    const resolved = await cases.resolve(
      org,
      target.id,
      '  timing del proveedor, cuadra el próximo periodo  ',
      userCtx
    );
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolution).toBe('timing del proveedor, cuadra el próximo periodo'); // trim
    expect(resolved.resolvedAt).not.toBeNull();
    expect(resolved.resolvedByUserId).toBe(userCtx.actorId);

    // Auditoría: acknowledged + resolved.
    const audit = await ctx.admin.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE resource_id = $1 AND resource_type = 'operational_case' ORDER BY id`,
      [target.id]
    );
    expect(audit.rows.map((r) => r.action)).toEqual([
      'operational_case.acknowledged',
      'operational_case.resolved',
    ]);
  });

  it('resolve via api_key actor leaves resolved_by_user_id null (audit keeps the actor)', async () => {
    const reportId = await reconcileWithDiscrepancies();
    await reconciliation.reconcile(org, reportId);
    const target = (await cases.list(org, { limit: 200 })).find((c) => c.reportId === reportId)!;
    const resolved = await cases.resolve(
      org,
      target.id,
      'confirmado, escalado a finanzas',
      apiKeyCtx
    );
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolvedByUserId).toBeNull();
  });

  it('rejects resolving an already-resolved case', async () => {
    const reportId = await reconcileWithDiscrepancies();
    await reconciliation.reconcile(org, reportId);
    const target = (await cases.list(org, { limit: 200 })).find((c) => c.reportId === reportId)!;
    await cases.resolve(org, target.id, 'listo', userCtx);
    await expect(cases.resolve(org, target.id, 'otra vez', userCtx)).rejects.toBeInstanceOf(
      InvalidCaseTransitionError
    );
    // Acknowledge sobre resuelto también falla.
    await expect(cases.acknowledge(org, target.id, userCtx)).rejects.toBeInstanceOf(
      InvalidCaseTransitionError
    );
  });

  it('isolates by tenant (a case is invisible to another tenant)', async () => {
    const reportId = await reconcileWithDiscrepancies();
    await reconciliation.reconcile(org, reportId);
    const target = (await cases.list(org, { limit: 200 })).find((c) => c.reportId === reportId)!;
    const other = await ctx.createTenant(`CASES-B ${randomUUID().slice(0, 8)}`);
    await expect(cases.get(other, target.id)).rejects.toBeInstanceOf(OperationalCaseNotFoundError);
  });
});
