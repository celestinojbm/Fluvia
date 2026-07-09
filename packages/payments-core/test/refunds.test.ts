import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenantTransaction } from '@fluvia/db';
import { createTestContext, type TestContext } from '@fluvia/db/testing';
import { LedgerService, PostingService } from '@fluvia/ledger';
import { Money } from '@fluvia/money';
import {
  CircuitOpenError,
  InvalidStateTransitionError,
  MockPaymentProvider,
  PaymentConfirmationService,
  PaymentIntentService,
  RefundAmountExceedsRemainingError,
  RefundService,
  ZERO_FEE_SCHEDULE,
  type PaymentProvider,
  type ProviderOutcome,
  type RefundPaymentInput,
} from '../src/index.js';

/**
 * F3-08 — refunds end-to-end contra PG real + ledger: asiento compensatorio
 * por la via normativa, invariante Σ refunds ≤ capturado, y la semantica de
 * desenlaces del dinero (aprobado / insuficiente / rechazo / circuito / throw).
 */

let ctx: TestContext;
let intents: PaymentIntentService;
let posting: PostingService;
let ledger: LedgerService;
let confirmation: PaymentConfirmationService;
let refunds: RefundService;
let org: string;
let merchantId: string;

const cop = (units: number) => Money.of(units, 'COP');

/** Proveedor con refund inyectable; submitPayment delega en el mock (seeding). */
class RefundStubProvider implements PaymentProvider {
  readonly name = 'mock';
  private readonly mock = new MockPaymentProvider();
  constructor(private readonly onRefund: (input: RefundPaymentInput) => Promise<ProviderOutcome>) {}
  submitPayment(input: Parameters<PaymentProvider['submitPayment']>[0]) {
    return this.mock.submitPayment(input);
  }
  refundPayment(input: RefundPaymentInput) {
    return this.onRefund(input);
  }
}

function refundServiceWith(onRefund: (input: RefundPaymentInput) => Promise<ProviderOutcome>) {
  return new RefundService(ctx.app, intents, posting, new RefundStubProvider(onRefund));
}

async function chartOf() {
  return posting.ensureChart(org, merchantId, 'COP');
}

async function available(code: string) {
  const chart = await chartOf();
  return (await ledger.getBalance(org, chart[code as keyof typeof chart])).available;
}

/** Intent en `succeeded` con `amount` capturado Y liberado a merchant.available. */
async function seedSucceeded(amount: number): Promise<string> {
  const intent = await intents.create({ tenantId: org, merchantId, amount: cop(amount) });
  const { attemptId } = await withTenantTransaction(ctx.app, org, (c) =>
    confirmation.beginIn(c, org, intent.id)
  );
  await confirmation.execute(org, attemptId, 'tok_approve');
  await posting.releaseSettlement({
    tenantId: org,
    merchantId,
    idempotencyKey: `settle:${intent.id}`,
    sourceType: 'settlement',
    sourceId: intent.id,
    amount: cop(amount),
  });
  return intent.id;
}

/**
 * Intent en `succeeded` con fondos aun en pending (merchant.available = 0).
 * Usa un merchant FRESCO: el org se comparte entre tests y otros liberan
 * fondos al available del merchant por defecto — aqui hace falta un 0 absoluto.
 */
async function seedSucceededNoRelease(amount: number): Promise<string> {
  const m = await ctx.admin.query<{ id: string }>(
    `INSERT INTO merchants (tenant_id, name) VALUES ($1, $2) RETURNING id`,
    [org, `refund-nr-${randomUUID().slice(0, 8)}`]
  );
  const freshMerchant = m.rows[0]!.id;
  const intent = await intents.create({
    tenantId: org,
    merchantId: freshMerchant,
    amount: cop(amount),
  });
  const { attemptId } = await withTenantTransaction(ctx.app, org, (c) =>
    confirmation.beginIn(c, org, intent.id)
  );
  await confirmation.execute(org, attemptId, 'tok_approve');
  return intent.id;
}

async function refundRow(refundId: string) {
  const res = await ctx.admin.query<{
    status: string;
    failure_code: string | null;
    provider_ref: string | null;
    amount: string;
  }>(`SELECT status, failure_code, provider_ref, amount::text FROM refunds WHERE id = $1`, [
    refundId,
  ]);
  return res.rows[0]!;
}

async function refundTopics(refundId: string): Promise<string[]> {
  const res = await ctx.admin.query<{ topic: string }>(
    `SELECT topic FROM outbox_events
     WHERE tenant_id = $1 AND payload->'data'->>'refund_id' = $2 ORDER BY id`,
    [org, refundId]
  );
  return res.rows.map((r) => r.topic);
}

beforeAll(async () => {
  ctx = await createTestContext();
  intents = new PaymentIntentService(ctx.app);
  ledger = new LedgerService(ctx.app);
  posting = new PostingService(ledger, ctx.app);
  confirmation = new PaymentConfirmationService(
    ctx.app,
    intents,
    posting,
    new MockPaymentProvider(),
    ZERO_FEE_SCHEDULE
  );
  refunds = new RefundService(ctx.app, intents, posting, new MockPaymentProvider());
  org = await ctx.createTenant(`Refund ${randomUUID().slice(0, 8)}`);
  const m = await ctx.admin.query<{ id: string }>(
    `INSERT INTO merchants (tenant_id, name) VALUES ($1, $2) RETURNING id`,
    [org, `refund-shop-${randomUUID().slice(0, 8)}`]
  );
  merchantId = m.rows[0]!.id;
}, 30_000);

afterAll(async () => {
  await ctx.close();
});

async function createRefund(
  svc: RefundService,
  input: { paymentIntentId: string; amount?: bigint; reason?: string }
) {
  return withTenantTransaction(ctx.app, org, (c) => svc.beginIn(c, org, input));
}

describe('RefundService — happy path', () => {
  it('full refund: intent -> refunded, compensating entry, available drained, ONE settle tx', async () => {
    const amount = 100_000;
    const intentId = await seedSucceeded(amount);
    const availBefore = await available('merchant.available');
    const clearingBefore = await available('provider.clearing');

    const refund = await createRefund(refunds, { paymentIntentId: intentId });
    expect(refund.status).toBe('created');
    expect(refund.amount).toBe(String(amount));
    await refunds.execute(org, refund.id);

    const row = await refundRow(refund.id);
    expect(row.status).toBe('succeeded');
    expect(row.provider_ref).toMatch(/^mockr_/);
    const intent = await intents.get(org, intentId);
    expect(intent.status).toBe('refunded');
    expect(intent.amountRefunded).toBe(String(amount));

    // merchant.available baja el monto; provider.clearing tambien (el proveedor
    // devuelve el dinero); refund.liability vuelve a 0 (reservado y descargado).
    expect(BigInt(availBefore) - BigInt(await available('merchant.available'))).toBe(
      BigInt(amount)
    );
    expect(BigInt(clearingBefore) - BigInt(await available('provider.clearing'))).toBe(
      BigInt(amount)
    );
    expect(await available('refund.liability')).toBe('0');

    // Asientos causales: request + settle, uno cada uno.
    const tx = await ctx.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ledger_transactions
       WHERE tenant_id = $1 AND source_type = 'refund' AND source_id = $2`,
      [org, refund.id]
    );
    expect(tx.rows[0]!.n).toBe(2);
    expect(await refundTopics(refund.id)).toEqual([
      'refund.created',
      'refund.processing',
      'refund.succeeded',
    ]);
  });

  it('partial refunds accumulate; over-refunding the remainder is rejected', async () => {
    const intentId = await seedSucceeded(100_000);

    const r1 = await createRefund(refunds, { paymentIntentId: intentId, amount: 30_000n });
    await refunds.execute(org, r1.id);
    expect((await intents.get(org, intentId)).status).toBe('partially_refunded');
    expect((await intents.get(org, intentId)).amountRefunded).toBe('30000');

    const r2 = await createRefund(refunds, { paymentIntentId: intentId, amount: 20_000n });
    await refunds.execute(org, r2.id);
    expect((await intents.get(org, intentId)).amountRefunded).toBe('50000');
    expect((await intents.get(org, intentId)).status).toBe('partially_refunded');

    // Remanente = 50000: pedir 60000 excede — irrepresentable.
    await expect(
      createRefund(refunds, { paymentIntentId: intentId, amount: 60_000n })
    ).rejects.toThrow(RefundAmountExceedsRemainingError);

    // El resto exacto lleva el intent a refunded.
    const r3 = await createRefund(refunds, { paymentIntentId: intentId });
    expect(r3.amount).toBe('50000'); // monto ausente = remanente
    await refunds.execute(org, r3.id);
    expect((await intents.get(org, intentId)).status).toBe('refunded');
    expect((await intents.get(org, intentId)).amountRefunded).toBe('100000');
  });

  it('an in-flight refund reserves quota: a second refund cannot exceed the remainder', async () => {
    const intentId = await seedSucceeded(100_000);
    // r1 creado pero SIN ejecutar la fase 2 (queda `created`, en vuelo).
    await createRefund(refunds, { paymentIntentId: intentId, amount: 70_000n });
    // Remanente disponible = 100000 - 0 aplicado - 70000 en vuelo = 30000.
    await expect(
      createRefund(refunds, { paymentIntentId: intentId, amount: 40_000n })
    ).rejects.toThrow(RefundAmountExceedsRemainingError);
    // 30000 si cabe.
    const ok = await createRefund(refunds, { paymentIntentId: intentId, amount: 30_000n });
    expect(ok.amount).toBe('30000');
  });

  it('execute is crash-safe: re-running after success is a no-op (no double settle)', async () => {
    const intentId = await seedSucceeded(40_000);
    const refund = await createRefund(refunds, { paymentIntentId: intentId });
    await refunds.execute(org, refund.id);
    await refunds.execute(org, refund.id); // reintento post-crash
    const tx = await ctx.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ledger_transactions
       WHERE tenant_id = $1 AND source_type = 'refund' AND source_id = $2`,
      [org, refund.id]
    );
    expect(tx.rows[0]!.n).toBe(2); // request + settle, jamas mas
    expect((await refundRow(refund.id)).status).toBe('succeeded');
  });
});

describe('RefundService — outcomes del dinero', () => {
  it('insufficient merchant balance: refund CANCELED, provider never contacted', async () => {
    // Fondos capturados pero NO liberados: merchant.available = 0.
    const intentId = await seedSucceededNoRelease(50_000);
    let providerCalled = false;
    const svc = refundServiceWith((input) => {
      providerCalled = true;
      return Promise.resolve({ outcome: 'approved', providerRef: `mockr_${input.refundId}` });
    });

    const refund = await createRefund(svc, { paymentIntentId: intentId });
    await svc.execute(org, refund.id);

    const row = await refundRow(refund.id);
    expect(row.status).toBe('canceled');
    expect(row.failure_code).toBe('insufficient_merchant_balance');
    expect(providerCalled).toBe(false); // desenlace CONOCIDO sin hablar con el proveedor
    // Intent intacto; nada reembolsado.
    expect((await intents.get(org, intentId)).status).toBe('succeeded');
    expect((await intents.get(org, intentId)).amountRefunded).toBe('0');
    expect(await refundTopics(refund.id)).toEqual(['refund.created', 'refund.canceled']);
  });

  it('provider declines the refund: FAILED and the reservation returns to the merchant', async () => {
    const intentId = await seedSucceeded(60_000);
    const availBefore = await available('merchant.available');
    const svc = refundServiceWith(() =>
      Promise.resolve({
        outcome: 'declined',
        providerRef: 'mockr_x',
        failureCode: 'refund_rejected',
      })
    );

    const refund = await createRefund(svc, { paymentIntentId: intentId });
    await svc.execute(org, refund.id);

    const row = await refundRow(refund.id);
    expect(row.status).toBe('failed');
    expect(row.failure_code).toBe('refund_rejected');
    // La reserva vuelve integra: available igual que antes, liability en 0.
    expect(await available('merchant.available')).toBe(availBefore);
    expect(await available('refund.liability')).toBe('0');
    expect((await intents.get(org, intentId)).amountRefunded).toBe('0');
    expect(await refundTopics(refund.id)).toEqual([
      'refund.created',
      'refund.processing',
      'refund.failed',
    ]);
  });

  it('circuit open: request NEVER sent -> clean FAILED provider_unavailable, reservation returned', async () => {
    const intentId = await seedSucceeded(25_000);
    const availBefore = await available('merchant.available');
    const svc = refundServiceWith(() => Promise.reject(new CircuitOpenError('mock', 30_000)));

    const refund = await createRefund(svc, { paymentIntentId: intentId });
    await svc.execute(org, refund.id);

    const row = await refundRow(refund.id);
    expect(row.status).toBe('failed');
    expect(row.failure_code).toBe('provider_unavailable');
    expect(await available('merchant.available')).toBe(availBefore);
    expect((await intents.get(org, intentId)).amountRefunded).toBe('0');
  });

  it('provider throws (unknown): refund -> INDETERMINATE, reservation RETAINED, no webhook', async () => {
    const intentId = await seedSucceeded(35_000);
    const availBefore = await available('merchant.available');
    const liabBefore = await available('refund.liability');
    const svc = refundServiceWith(() => Promise.reject(new Error('connection reset')));

    const refund = await createRefund(svc, { paymentIntentId: intentId });
    await svc.execute(org, refund.id);

    const row = await refundRow(refund.id);
    // Desenlace DESCONOCIDO (V4 §23): estado propio, NADA lo resuelve por asuncion.
    expect(row.status).toBe('indeterminate');
    // La reserva SIGUE retenida (el dinero pudo haberse movido en el proveedor).
    expect(BigInt(availBefore) - BigInt(await available('merchant.available'))).toBe(35_000n);
    expect(BigInt(await available('refund.liability')) - BigInt(liabBefore)).toBe(35_000n);
    expect((await intents.get(org, intentId)).amountRefunded).toBe('0');
    // `indeterminate` es interno: el comercio ve `processing`, sin webhook nuevo.
    expect(await refundTopics(refund.id)).toEqual(['refund.created', 'refund.processing']);

    // Re-ejecutar NO re-llama al proveedor (no re-envio de un desenlace desconocido).
    let calls = 0;
    const svc2 = refundServiceWith(() => {
      calls += 1;
      return Promise.resolve({ outcome: 'approved', providerRef: 'mockr_x' });
    });
    await svc2.execute(org, refund.id);
    expect(calls).toBe(0);
    expect((await refundRow(refund.id)).status).toBe('indeterminate');
  });

  it('provider pending (async-accepted): refund -> INDETERMINATE, NOT a false decline', async () => {
    const intentId = await seedSucceeded(45_000);
    const availBefore = await available('merchant.available');
    const liabBefore = await available('refund.liability');
    const svc = refundServiceWith(() =>
      Promise.resolve({ outcome: 'pending', providerRef: 'mockr_pse' })
    );

    const refund = await createRefund(svc, { paymentIntentId: intentId });
    await svc.execute(org, refund.id);

    const row = await refundRow(refund.id);
    // pending NO es un rechazo: la reserva NO se devuelve (seria resolver por asuncion).
    expect(row.status).toBe('indeterminate');
    expect(BigInt(availBefore) - BigInt(await available('merchant.available'))).toBe(45_000n);
    expect(BigInt(await available('refund.liability')) - BigInt(liabBefore)).toBe(45_000n);
  });

  it('resolveFromProvider settles an INDETERMINATE refund on verified success', async () => {
    const intentId = await seedSucceeded(60_000);
    const svc = refundServiceWith(() => Promise.reject(new Error('timeout')));
    const refund = await createRefund(svc, { paymentIntentId: intentId });
    await svc.execute(org, refund.id);
    expect((await refundRow(refund.id)).status).toBe('indeterminate');
    const liabBeforeResolve = await available('refund.liability');

    const outcome = await svc.resolveFromProvider(org, {
      refundId: refund.id,
      result: 'succeeded',
      providerRef: 'mockr_confirmed',
    });
    expect(outcome).toBe('applied');
    expect((await refundRow(refund.id)).status).toBe('succeeded');
    expect((await intents.get(org, intentId)).amountRefunded).toBe('60000');
    // El settle descarga la reserva de ESTE refund (liability baja 60000).
    expect(BigInt(liabBeforeResolve) - BigInt(await available('refund.liability'))).toBe(60_000n);

    // Evento verificado tardio/contradictorio: fuera de orden, sin doble asiento.
    const late = await svc.resolveFromProvider(org, { refundId: refund.id, result: 'failed' });
    expect(late).toBe('ignored_out_of_order');
    const tx = await ctx.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ledger_transactions
       WHERE tenant_id = $1 AND source_type = 'refund' AND source_id = $2`,
      [org, refund.id]
    );
    expect(tx.rows[0]!.n).toBe(2); // request + settle, jamas mas
  });

  it('resolveFromProvider fails an INDETERMINATE refund on verified failure, returning the reservation', async () => {
    const intentId = await seedSucceeded(20_000);
    const svc = refundServiceWith(() => Promise.reject(new Error('timeout')));
    const refund = await createRefund(svc, { paymentIntentId: intentId });
    await svc.execute(org, refund.id);
    expect((await refundRow(refund.id)).status).toBe('indeterminate');
    const availBeforeResolve = await available('merchant.available');
    const liabBeforeResolve = await available('refund.liability');

    const outcome = await svc.resolveFromProvider(org, {
      refundId: refund.id,
      result: 'failed',
      failureCode: 'refund_rejected',
    });
    expect(outcome).toBe('applied');
    const row = await refundRow(refund.id);
    expect(row.status).toBe('failed');
    expect(row.failure_code).toBe('refund_rejected');
    // Reserva devuelta integra tras la resolucion verificada: available +20000,
    // liability -20000.
    expect(BigInt(await available('merchant.available')) - BigInt(availBeforeResolve)).toBe(
      20_000n
    );
    expect(BigInt(liabBeforeResolve) - BigInt(await available('refund.liability'))).toBe(20_000n);
    expect((await intents.get(org, intentId)).amountRefunded).toBe('0');
  });
});

describe('RefundService — guards de estado y tenant', () => {
  it('refunding an intent that is not succeeded/partially_refunded is illegal', async () => {
    const intent = await intents.create({ tenantId: org, merchantId, amount: cop(10_000) });
    // Sigue en `created`: no hay nada capturado que reembolsar.
    await expect(createRefund(refunds, { paymentIntentId: intent.id })).rejects.toThrow(
      InvalidStateTransitionError
    );
  });

  it('cross-tenant: another tenant cannot open a refund against this intent', async () => {
    const intentId = await seedSucceeded(15_000);
    const orgB = await ctx.createTenant(`Refund-B ${randomUUID().slice(0, 8)}`);
    // El intent de `org` es invisible bajo RLS para orgB: not found.
    await expect(
      withTenantTransaction(ctx.app, orgB, (c) =>
        refunds.beginIn(c, orgB, { paymentIntentId: intentId })
      )
    ).rejects.toThrow(/not found/i);
  });
});

describe('RefundService — configuracion', () => {
  it('rejects a provider without refund support at construction time', () => {
    const noRefund: PaymentProvider = {
      name: 'no-refund',
      submitPayment: () => Promise.resolve({ outcome: 'approved', providerRef: 'x' }),
    };
    expect(() => new RefundService(ctx.app, intents, posting, noRefund)).toThrow(
      /does not support/
    );
  });
});
