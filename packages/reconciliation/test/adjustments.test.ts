import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditContext } from '@fluvia/audit';
import { createTestContext, type TestContext } from '@fluvia/db/testing';
import { LedgerService, PostingService } from '@fluvia/ledger';
import {
  CaseAdjustmentExistsError,
  CaseAdjustmentService,
  HumanActorRequiredError,
  InvalidAdjustmentTransitionError,
  OperationalCaseService,
  ReconciliationService,
  SelfApprovalError,
} from '../src/index.js';

/**
 * F4-03b — ajuste monetario con four-eyes (Nivel C). Verifica el invariante:
 * ni la IA/máquina ni un solo humano autorizan dinero real sobre umbral; al
 * aprobarse (segundo humano distinto) se postea un asiento compensatorio real
 * (recon.differences ↔ suspense) enlazado al caso, y el caso queda resuelto.
 */

let ctx: TestContext;
let reconciliation: ReconciliationService;
let cases: OperationalCaseService;
let adjustments: CaseAdjustmentService; // umbral 100_000
let org: string;

const PERIOD_START = new Date('2026-06-01T00:00:00Z');
const PERIOD_END = new Date('2026-07-01T00:00:00Z');
const IN_PERIOD = new Date('2026-06-15T12:00:00Z');
const THRESHOLD = 100_000n;

const u1: AuditContext = { actorType: 'user', actorId: randomUUID(), authMethod: 'session' };
const u2: AuditContext = { actorType: 'user', actorId: randomUUID(), authMethod: 'session' };
const machine: AuditContext = {
  actorType: 'api_key',
  actorId: randomUUID(),
  authMethod: 'api_key',
};

/** Concilia un reporte con 1 discrepancia (missing_in_ledger) y devuelve el caso. */
async function caseFromDiscrepancy(): Promise<string> {
  const report = await reconciliation.createReport(org, {
    provider: 'mock',
    currency: 'COP',
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
  });
  await reconciliation.addLines(org, report.id, [
    { providerRef: `phantom-${randomUUID().slice(0, 8)}`, amount: 9_000n, settledAt: IN_PERIOD },
  ]);
  await reconciliation.reconcile(org, report.id);
  const list = await cases.list(org, { limit: 200 });
  return list.find((c) => c.reportId === report.id)!.id;
}

async function ledgerAsiento(sourceId: string) {
  const tx = await ctx.admin.query<{ id: string; source_type: string }>(
    `SELECT id, source_type FROM ledger_transactions WHERE source_id = $1`,
    [sourceId]
  );
  if (!tx.rows[0]) return null;
  const entries = await ctx.admin.query<{ direction: string; amount: string }>(
    `SELECT e.direction, e.amount::text AS amount
     FROM ledger_entries e WHERE e.tx_root_id = $1`,
    [tx.rows[0].id]
  );
  return { tx: tx.rows[0], entries: entries.rows };
}

beforeAll(async () => {
  ctx = await createTestContext();
  reconciliation = new ReconciliationService(ctx.app);
  cases = new OperationalCaseService(ctx.app);
  const posting = new PostingService(new LedgerService(ctx.app), ctx.app);
  adjustments = new CaseAdjustmentService(ctx.app, posting, { fourEyesThresholdMinor: THRESHOLD });
  org = await ctx.createTenant(`ADJ ${randomUUID().slice(0, 8)}`);
}, 30_000);

afterAll(async () => {
  await ctx.close();
});

describe('four-eyes de ajustes de caso', () => {
  it('rejects a machine actor (Level A: money is a human act)', async () => {
    const caseId = await caseFromDiscrepancy();
    await expect(
      adjustments.propose(
        org,
        caseId,
        { amount: 50_000n, currency: 'COP', direction: 'debit_differences', reason: 'x' },
        machine
      )
    ).rejects.toBeInstanceOf(HumanActorRequiredError);
  });

  it('over threshold: proposer cannot self-approve; a distinct human applies + posts the asiento', async () => {
    const caseId = await caseFromDiscrepancy();
    const adj = await adjustments.propose(
      org,
      caseId,
      {
        amount: 200_000n,
        currency: 'COP',
        direction: 'debit_differences',
        reason: 'diferencia real',
      },
      u1
    );
    expect(adj.requiresSecondApproval).toBe(true);
    expect(adj.status).toBe('proposed');

    // El proponente NO puede aprobar su propio ajuste sobre umbral.
    await expect(adjustments.approve(org, adj.id, u1)).rejects.toBeInstanceOf(SelfApprovalError);

    // Un segundo humano distinto sí: se aplica y postea el asiento.
    const applied = await adjustments.approve(org, adj.id, u2);
    expect(applied.status).toBe('applied');
    expect(applied.approvedByUserId).toBe(u2.actorId);
    expect(applied.ledgerTransactionId).not.toBeNull();

    // El asiento compensatorio real existe, balanceado y enlazado al ajuste.
    const asiento = await ledgerAsiento(adj.id);
    expect(asiento?.tx.source_type).toBe('case_adjustment');
    expect(asiento?.entries).toHaveLength(2);
    const debit = asiento!.entries.find((e) => e.direction === 'debit')!;
    const credit = asiento!.entries.find((e) => e.direction === 'credit')!;
    expect(debit.amount).toBe('200000');
    expect(credit.amount).toBe('200000'); // débitos == créditos

    // El caso quedó resuelto por el ajuste.
    expect((await cases.get(org, caseId)).status).toBe('resolved');
  });

  it('under threshold: the proposer may self-approve (no second human required)', async () => {
    const caseId = await caseFromDiscrepancy();
    const adj = await adjustments.propose(
      org,
      caseId,
      { amount: 50_000n, currency: 'COP', direction: 'credit_differences', reason: 'ajuste menor' },
      u1
    );
    expect(adj.requiresSecondApproval).toBe(false);
    const applied = await adjustments.approve(org, adj.id, u1); // mismo actor, permitido
    expect(applied.status).toBe('applied');
    expect((await cases.get(org, caseId)).status).toBe('resolved');
  });

  it('cannot re-approve an applied adjustment (idempotent: no second asiento)', async () => {
    const caseId = await caseFromDiscrepancy();
    const adj = await adjustments.propose(
      org,
      caseId,
      { amount: 30_000n, currency: 'COP', direction: 'debit_differences', reason: 'menor' },
      u1
    );
    await adjustments.approve(org, adj.id, u1);
    await expect(adjustments.approve(org, adj.id, u1)).rejects.toBeInstanceOf(
      InvalidAdjustmentTransitionError
    );
    // Exactamente un asiento para ese ajuste.
    const tx = await ctx.admin.query(
      `SELECT count(*)::int AS n FROM ledger_transactions WHERE source_id = $1`,
      [adj.id]
    );
    expect((tx.rows[0] as { n: number }).n).toBe(1);
  });

  it('reject frees the case for a new proposal (partial-unique index)', async () => {
    const caseId = await caseFromDiscrepancy();
    const first = await adjustments.propose(
      org,
      caseId,
      { amount: 200_000n, currency: 'COP', direction: 'debit_differences', reason: 'primera' },
      u1
    );
    // No se puede proponer un segundo mientras hay uno vivo.
    await expect(
      adjustments.propose(
        org,
        caseId,
        { amount: 10_000n, currency: 'COP', direction: 'debit_differences', reason: 'dup' },
        u1
      )
    ).rejects.toBeInstanceOf(CaseAdjustmentExistsError);

    const rejected = await adjustments.reject(org, first.id, 'monto incorrecto', u2);
    expect(rejected.status).toBe('rejected');
    expect(rejected.rejectedByUserId).toBe(u2.actorId);

    // Tras el rechazo, una nueva propuesta es posible.
    const second = await adjustments.propose(
      org,
      caseId,
      { amount: 5_000n, currency: 'COP', direction: 'debit_differences', reason: 'corregida' },
      u1
    );
    expect(second.status).toBe('proposed');
  });

  it('isolates by tenant', async () => {
    const caseId = await caseFromDiscrepancy();
    const adj = await adjustments.propose(
      org,
      caseId,
      { amount: 40_000n, currency: 'COP', direction: 'debit_differences', reason: 'x' },
      u1
    );
    const other = await ctx.createTenant(`ADJ-B ${randomUUID().slice(0, 8)}`);
    await expect(adjustments.get(other, adj.id)).rejects.toBeInstanceOf(
      // CaseAdjustmentNotFoundError, importado indirectamente
      Error
    );
    expect((await adjustments.get(org, adj.id)).id).toBe(adj.id);
  });
});
