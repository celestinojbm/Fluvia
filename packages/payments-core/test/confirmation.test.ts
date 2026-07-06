import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenantTransaction } from '@fluvia/db';
import { createTestContext, type TestContext } from '@fluvia/db/testing';
import { LedgerService, PostingService } from '@fluvia/ledger';
import { Money } from '@fluvia/money';
import {
  FlatBpsFeeSchedule,
  InvalidStateTransitionError,
  MockPaymentProvider,
  PaymentConfirmationService,
  PaymentIntentService,
  ZERO_FEE_SCHEDULE,
} from '../src/index.js';

/**
 * F3-03 — el ciclo confirmar->attempt->resultado contra PG real, incluida la
 * composicion atomica con el ledger (capturePayment + onPosted).
 */

let ctx: TestContext;
let intents: PaymentIntentService;
let posting: PostingService;
let confirmation: PaymentConfirmationService;
let org: string;
let merchantId: string;

beforeAll(async () => {
  ctx = await createTestContext();
  intents = new PaymentIntentService(ctx.app);
  const ledger = new LedgerService(ctx.app);
  posting = new PostingService(ledger, ctx.app);
  confirmation = new PaymentConfirmationService(
    ctx.app,
    intents,
    posting,
    new MockPaymentProvider(),
    ZERO_FEE_SCHEDULE
  );
  org = await ctx.createTenant(`Confirm ${randomUUID().slice(0, 8)}`);
  const m = await ctx.admin.query<{ id: string }>(
    `INSERT INTO merchants (tenant_id, name) VALUES ($1, $2) RETURNING id`,
    [org, `confirm-shop-${randomUUID().slice(0, 8)}`]
  );
  merchantId = m.rows[0]!.id;
}, 30_000);

afterAll(async () => {
  await ctx.close();
});

const cop = (units: number) => Money.of(units, 'COP');

async function begin(intentId: string) {
  return withTenantTransaction(ctx.app, org, (c) => confirmation.beginIn(c, org, intentId));
}

async function attemptRow(attemptId: string) {
  const res = await ctx.admin.query<{
    status: string;
    provider_ref: string | null;
    last_error: string | null;
  }>(`SELECT status, provider_ref, last_error FROM payment_attempts WHERE id = $1`, [attemptId]);
  return res.rows[0]!;
}

describe('PaymentConfirmationService (F3-03)', () => {
  it('begin walks the FSM to processing and creates the attempt in submitting', async () => {
    const intent = await intents.create({ tenantId: org, merchantId, amount: cop(50_000) });
    const { intent: after, attemptId } = await begin(intent.id);
    expect(after.status).toBe('processing');
    expect((await attemptRow(attemptId)).status).toBe('submitting');
    // Todo el camino quedo en el outbox (created->...->processing).
    const topics = await ctx.admin.query<{ topic: string }>(
      `SELECT topic FROM outbox_events
       WHERE tenant_id = $1 AND payload->'data'->>'payment_intent_id' = $2 ORDER BY id`,
      [org, intent.id]
    );
    expect(topics.rows.map((r) => r.topic)).toEqual([
      'payment_intent.created',
      'payment_intent.requires_payment_method',
      'payment_intent.requires_confirmation',
      'payment_intent.processing',
    ]);
  });

  it('approved: ledger capture + attempt succeeded + intent succeeded, ONE atomic unit', async () => {
    const amount = 120_000;
    const intent = await intents.create({ tenantId: org, merchantId, amount: cop(amount) });
    const { attemptId } = await begin(intent.id);

    const chart = await posting.ensureChart(org, merchantId, 'COP');
    const before = await new LedgerService(ctx.app).getBalance(org, chart['merchant.pending']);

    await confirmation.execute(org, attemptId, 'tok_approve');

    const att = await attemptRow(attemptId);
    expect(att.status).toBe('succeeded');
    expect(att.provider_ref).toMatch(/^mock_/);
    const after = await intents.get(org, intent.id);
    expect(after.status).toBe('succeeded');
    expect(after.amountCaptured).toBe(String(amount));

    // merchant.pending crecio EXACTAMENTE el monto (este servicio usa
    // ZERO_FEE_SCHEDULE; el fee al 2% se prueba abajo con FlatBpsFeeSchedule).
    const balance = await new LedgerService(ctx.app).getBalance(org, chart['merchant.pending']);
    expect(BigInt(balance.available) - BigInt(before.available)).toBe(BigInt(amount));

    // El asiento referencia causalmente al attempt.
    const tx = await ctx.admin.query(
      `SELECT 1 FROM ledger_transactions
       WHERE tenant_id = $1 AND source_type = 'payment_attempt' AND source_id = $2`,
      [org, attemptId]
    );
    expect(tx.rowCount).toBe(1);
  });

  // F4-05c (PEND-002): con el motor de fees al 2%, la captura reparte el monto
  // bruto entre el ingreso de Fluvia (platform.fees) y el pasivo con el comercio
  // (merchant.pending): Ff = 2%, comercio = 98%.
  it('con FlatBpsFeeSchedule(200) la captura credita platform.fees=2% y merchant.pending=98%', async () => {
    const feeSvc = new PaymentConfirmationService(
      ctx.app,
      intents,
      posting,
      new MockPaymentProvider(),
      new FlatBpsFeeSchedule(200)
    );
    const amount = 100_000;
    const intent = await intents.create({ tenantId: org, merchantId, amount: cop(amount) });
    const { attemptId } = await begin(intent.id);

    const chart = await posting.ensureChart(org, merchantId, 'COP');
    const ledger = new LedgerService(ctx.app);
    const bal = async (code: 'merchant.pending' | 'platform.fees') =>
      BigInt((await ledger.getBalance(org, chart[code])).available);
    const pendingBefore = await bal('merchant.pending');
    const feesBefore = await bal('platform.fees');

    await feeSvc.execute(org, attemptId, 'tok_approve');

    const feeDelta = (await bal('platform.fees')) - feesBefore;
    const pendingDelta = (await bal('merchant.pending')) - pendingBefore;
    expect(feeDelta).toBe(2_000n); // 2% de 100000 = ingreso de Fluvia
    expect(pendingDelta).toBe(98_000n); // 98% para el comercio
    // El bruto cuadra: comercio + fee == monto capturado (sin perder unidades).
    expect(pendingDelta + feeDelta).toBe(BigInt(amount));
  });

  it('execute is crash-safe: re-running after resolution is a no-op (no double capture)', async () => {
    const intent = await intents.create({ tenantId: org, merchantId, amount: cop(10_000) });
    const { attemptId } = await begin(intent.id);
    await confirmation.execute(org, attemptId, 'tok_approve');
    await confirmation.execute(org, attemptId, 'tok_approve'); // reintento post-crash
    const txs = await ctx.admin.query(
      `SELECT count(*)::int AS n FROM ledger_transactions
       WHERE tenant_id = $1 AND source_type = 'payment_attempt' AND source_id = $2`,
      [org, attemptId]
    );
    expect((txs.rows[0] as { n: number }).n).toBe(1);
  });

  it('declined: attempt failed + intent failed with failure_code, ZERO ledger entries', async () => {
    const intent = await intents.create({ tenantId: org, merchantId, amount: cop(30_000) });
    const { attemptId } = await begin(intent.id);
    await confirmation.execute(org, attemptId, 'tok_decline_insufficient');

    expect((await attemptRow(attemptId)).status).toBe('failed');
    const after = await intents.get(org, intent.id);
    expect(after.status).toBe('failed');
    expect(after.failureCode).toBe('insufficient_funds');
    const tx = await ctx.admin.query(
      `SELECT 1 FROM ledger_transactions WHERE source_type = 'payment_attempt' AND source_id = $1`,
      [attemptId]
    );
    expect(tx.rowCount).toBe(0);
  });

  it('timeout: attempt INDETERMINATE, intent stays processing, nothing resolves by assumption', async () => {
    const intent = await intents.create({ tenantId: org, merchantId, amount: cop(40_000) });
    const { attemptId } = await begin(intent.id);
    await confirmation.execute(org, attemptId, 'tok_timeout');

    const att = await attemptRow(attemptId);
    expect(att.status).toBe('indeterminate');
    expect(att.last_error).toContain('outcome unknown');
    expect((await intents.get(org, intent.id)).status).toBe('processing');
    // Re-ejecutar NO lo resuelve: sigue indeterminate (solo fuente verificada).
    await confirmation.execute(org, attemptId, 'tok_timeout');
    expect((await attemptRow(attemptId)).status).toBe('indeterminate');
  });

  it('tok_pse (async): attempt SUBMITTED with provider_ref, intent stays processing', async () => {
    const intent = await intents.create({ tenantId: org, merchantId, amount: cop(70_000) });
    const { attemptId } = await begin(intent.id);
    await confirmation.execute(org, attemptId, 'tok_pse');
    const att = await attemptRow(attemptId);
    expect(att.status).toBe('submitted');
    expect(att.provider_ref).toMatch(/^mock_/);
    expect((await intents.get(org, intent.id)).status).toBe('processing');
  });

  it('resolveFromProvider succeeds a SUBMITTED attempt with the same atomic capture', async () => {
    const amount = 88_000;
    const intent = await intents.create({ tenantId: org, merchantId, amount: cop(amount) });
    const { attemptId } = await begin(intent.id);
    await confirmation.execute(org, attemptId, 'tok_pse');
    const ref = (await attemptRow(attemptId)).provider_ref!;

    const outcome = await confirmation.resolveFromProvider(org, {
      attemptId,
      providerRef: ref,
      result: 'succeeded',
    });
    expect(outcome).toBe('applied');
    expect((await attemptRow(attemptId)).status).toBe('succeeded');
    const after = await intents.get(org, intent.id);
    expect(after.status).toBe('succeeded');
    expect(after.amountCaptured).toBe(String(amount));

    // Webhook tardio/duplicado (otro event_id): fuera de orden, SIN doble asiento.
    const late = await confirmation.resolveFromProvider(org, {
      attemptId,
      providerRef: ref,
      result: 'failed',
    });
    expect(late).toBe('ignored_out_of_order');
    const txs = await ctx.admin.query(
      `SELECT count(*)::int AS n FROM ledger_transactions
       WHERE tenant_id = $1 AND source_type = 'payment_attempt' AND source_id = $2`,
      [org, attemptId]
    );
    expect((txs.rows[0] as { n: number }).n).toBe(1);
  });

  it('resolveFromProvider is THE verified source that closes an INDETERMINATE attempt', async () => {
    const intent = await intents.create({ tenantId: org, merchantId, amount: cop(15_000) });
    const { attemptId } = await begin(intent.id);
    await confirmation.execute(org, attemptId, 'tok_timeout');
    expect((await attemptRow(attemptId)).status).toBe('indeterminate');

    const outcome = await confirmation.resolveFromProvider(org, {
      attemptId,
      providerRef: 'mock_late_ref_from_webhook',
      result: 'failed',
      failureCode: 'card_declined',
    });
    expect(outcome).toBe('applied');
    expect((await attemptRow(attemptId)).status).toBe('failed');
    const after = await intents.get(org, intent.id);
    expect(after.status).toBe('failed');
    expect(after.failureCode).toBe('card_declined');
  });

  it('resolveFromProvider ignores unknown attempts and mismatched references', async () => {
    expect(
      await confirmation.resolveFromProvider(org, {
        attemptId: '00000000-0000-4000-8000-000000000000',
        providerRef: 'mock_x',
        result: 'succeeded',
      })
    ).toBe('ignored');

    const intent = await intents.create({ tenantId: org, merchantId, amount: cop(9_000) });
    const { attemptId } = await begin(intent.id);
    await confirmation.execute(org, attemptId, 'tok_pse');
    expect(
      await confirmation.resolveFromProvider(org, {
        attemptId,
        providerRef: 'mock_WRONG_reference',
        result: 'succeeded',
      })
    ).toBe('ignored');
    expect((await attemptRow(attemptId)).status).toBe('submitted');
  });

  it('begin rejects intents already processing or terminal (FSM decides)', async () => {
    const intent = await intents.create({ tenantId: org, merchantId, amount: cop(5_000) });
    await begin(intent.id);
    await expect(begin(intent.id)).rejects.toThrow(InvalidStateTransitionError);

    const canceled = await intents.create({ tenantId: org, merchantId, amount: cop(5_000) });
    await intents.transition(org, canceled.id, 'canceled');
    await expect(begin(canceled.id)).rejects.toThrow(InvalidStateTransitionError);
  });
});
