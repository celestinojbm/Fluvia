import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenantTransaction } from '@fluvia/db';
import { createTestContext, type TestContext } from '@fluvia/db/testing';
import { LedgerService, PostingService } from '@fluvia/ledger';
import { Money } from '@fluvia/money';
import {
  CircuitOpenError,
  MockPaymentProvider,
  PaymentConfirmationService,
  PaymentIntentService,
  ZERO_FEE_SCHEDULE,
  type PaymentProvider,
} from '../src/index.js';

/**
 * F3-04 — sweep_payment_attempts() (0018) contra PG real + la semantica de
 * circuito abierto en la confirmacion (fallo limpio, jamas ambiguo).
 */

let ctx: TestContext;
let intents: PaymentIntentService;
let confirmation: PaymentConfirmationService;
let org: string;
let merchantId: string;

beforeAll(async () => {
  ctx = await createTestContext();
  intents = new PaymentIntentService(ctx.app);
  confirmation = new PaymentConfirmationService(
    ctx.app,
    intents,
    new PostingService(new LedgerService(ctx.app), ctx.app),
    new MockPaymentProvider(),
    ZERO_FEE_SCHEDULE
  );
  org = await ctx.createTenant(`Watchdog ${randomUUID().slice(0, 8)}`);
  merchantId = (
    await ctx.admin.query<{ id: string }>(
      `INSERT INTO merchants (tenant_id, name) VALUES ($1, $2) RETURNING id`,
      [org, `wd-shop-${randomUUID().slice(0, 8)}`]
    )
  ).rows[0]!.id;
}, 30_000);

afterAll(async () => {
  await ctx.close();
});

const cop = (units: number) => Money.of(units, 'COP');

async function stuckAttempt(ageMinutes: number): Promise<string> {
  const intent = await intents.create({ tenantId: org, merchantId, amount: cop(10_000) });
  const { attemptId } = await withTenantTransaction(ctx.app, org, (c) =>
    confirmation.beginIn(c, org, intent.id)
  );
  // Simula el crash entre fases: submitting con submitted_at viejo (UPDATE de
  // columna no-status: el trigger de FSM no interviene).
  await ctx.admin.query(
    `UPDATE payment_attempts SET submitted_at = now() - make_interval(mins => $2) WHERE id = $1`,
    [attemptId, ageMinutes]
  );
  return attemptId;
}

describe('sweep_payment_attempts() — barrido y salud (0018)', () => {
  it('sweeps ONLY past-lease submitting attempts to indeterminate, with atomic audit', async () => {
    const stale = await stuckAttempt(10);
    const fresh = await stuckAttempt(1);

    const res = await ctx.worker.query<{ metric: string; value: string }>(
      `SELECT metric, value::text FROM sweep_payment_attempts()`
    );
    const byMetric = Object.fromEntries(res.rows.map((r) => [r.metric, Number(r.value)]));
    expect(byMetric.swept_to_indeterminate).toBeGreaterThanOrEqual(1);
    expect(byMetric.indeterminate_total).toBeGreaterThanOrEqual(1);

    const staleRow = await ctx.admin.query<{ status: string; last_error: string }>(
      `SELECT status, last_error FROM payment_attempts WHERE id = $1`,
      [stale]
    );
    expect(staleRow.rows[0]!.status).toBe('indeterminate');
    expect(staleRow.rows[0]!.last_error).toContain('outcome unknown');
    // El fresco sigue en submitting: el lease manda.
    const freshRow = await ctx.admin.query<{ status: string }>(
      `SELECT status FROM payment_attempts WHERE id = $1`,
      [fresh]
    );
    expect(freshRow.rows[0]!.status).toBe('submitting');

    // Auditoria atomica con los ids barridos.
    const audit = await ctx.admin.query<{ after_summary: { attempt_ids: string[] } }>(
      `SELECT after_summary FROM audit_events
       WHERE action = 'payment_attempt.swept_indeterminate'
       ORDER BY id DESC LIMIT 1`
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0]!.after_summary.attempt_ids).toContain(stale);
  });

  it('a swept attempt is still resolvable ONLY via verified source (webhook path)', async () => {
    const swept = await stuckAttempt(10);
    await ctx.worker.query(`SELECT * FROM sweep_payment_attempts()`);
    const outcome = await confirmation.resolveFromProvider(org, {
      attemptId: swept,
      providerRef: 'mock_recovered_ref',
      result: 'succeeded',
    });
    expect(outcome).toBe('applied');
    const row = await ctx.admin.query<{ status: string }>(
      `SELECT status FROM payment_attempts WHERE id = $1`,
      [swept]
    );
    expect(row.rows[0]!.status).toBe('succeeded');
  });

  it('aged indeterminate attempts are counted for the baseline alert', async () => {
    const aged = await stuckAttempt(10);
    await ctx.worker.query(`SELECT * FROM sweep_payment_attempts()`);
    await ctx.admin.query(
      `UPDATE payment_attempts SET updated_at = now() - interval '45 minutes' WHERE id = $1`,
      [aged]
    );
    const res = await ctx.worker.query<{ metric: string; value: string }>(
      `SELECT metric, value::text FROM sweep_payment_attempts()`
    );
    const byMetric = Object.fromEntries(res.rows.map((r) => [r.metric, Number(r.value)]));
    expect(byMetric.indeterminate_aged).toBeGreaterThanOrEqual(1);
  });

  it('only the worker role may execute the sweep', async () => {
    await expect(ctx.app.query(`SELECT * FROM sweep_payment_attempts()`)).rejects.toThrow(
      /permission denied/i
    );
    await expect(ctx.relay.query(`SELECT * FROM sweep_payment_attempts()`)).rejects.toThrow(
      /permission denied/i
    );
  });
});

describe('circuito abierto en la confirmacion (fallo limpio)', () => {
  it('CircuitOpenError -> attempt failed provider_unavailable (known outcome, no ledger)', async () => {
    const alwaysOpen: PaymentProvider = {
      name: 'mock',
      submitPayment: () => Promise.reject(new CircuitOpenError('mock', 30_000)),
    };
    const svc = new PaymentConfirmationService(
      ctx.app,
      intents,
      new PostingService(new LedgerService(ctx.app), ctx.app),
      alwaysOpen,
      ZERO_FEE_SCHEDULE
    );
    const intent = await intents.create({ tenantId: org, merchantId, amount: cop(20_000) });
    const { attemptId } = await withTenantTransaction(ctx.app, org, (c) =>
      svc.beginIn(c, org, intent.id)
    );
    await svc.execute(org, attemptId, 'tok_approve');

    const att = await ctx.admin.query<{ status: string; last_error: string }>(
      `SELECT status, last_error FROM payment_attempts WHERE id = $1`,
      [attemptId]
    );
    expect(att.rows[0]!.status).toBe('failed');
    expect(att.rows[0]!.last_error).toBe('provider_unavailable');
    const after = await intents.get(org, intent.id);
    expect(after.status).toBe('failed');
    expect(after.failureCode).toBe('provider_unavailable');
    const tx = await ctx.admin.query(
      `SELECT 1 FROM ledger_transactions WHERE source_type = 'payment_attempt' AND source_id = $1`,
      [attemptId]
    );
    expect(tx.rowCount).toBe(0);
  });
});
