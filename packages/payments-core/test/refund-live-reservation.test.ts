import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenantTransaction } from '@fluvia/db';
import { createTestContext, type TestContext } from '@fluvia/db/testing';
import { LedgerService, PostingService } from '@fluvia/ledger';
import { Money } from '@fluvia/money';
import {
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
 * Cupo VIVO de un cobro (0048) contra PG real + ledger. Un refund
 * `indeterminate` (el proveedor pudo ejecutarlo; su reserva sigue retenida)
 * reserva cupo igual que created/processing: una segunda devolución del mismo
 * cobro NO puede nacer mientras no se resuelva. Antes la única barrera era el
 * guard de no-negatividad del ledger — insuficiente si el comercio tenía saldo
 * de otros cobros (se reproducía una doble devolución del mismo dinero).
 */

let ctx: TestContext;
let intents: PaymentIntentService;
let posting: PostingService;
let ledger: LedgerService;
let confirmation: PaymentConfirmationService;
let org: string;

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

const unknownOutcome = () => Promise.reject(new Error('connection reset'));
const approve = (input: RefundPaymentInput) =>
  Promise.resolve<ProviderOutcome>({ outcome: 'approved', providerRef: `mockr_${input.refundId}` });
const svc = (onRefund: (input: RefundPaymentInput) => Promise<ProviderOutcome>) =>
  new RefundService(ctx.app, intents, posting, new RefundStubProvider(onRefund));

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
  org = await ctx.createTenant(`RefundLive ${randomUUID().slice(0, 8)}`);
}, 30_000);

afterAll(async () => {
  await ctx.close();
});

/** Merchant FRESCO por caso: los saldos del comercio no se mezclan entre tests. */
async function freshMerchant(): Promise<string> {
  const m = await ctx.admin.query<{ id: string }>(
    `INSERT INTO merchants (tenant_id, name) VALUES ($1, $2) RETURNING id`,
    [org, `refund-live-${randomUUID().slice(0, 8)}`]
  );
  return m.rows[0]!.id;
}

/** Cobro aprobado por el MockProvider y liberado a merchant.available. */
async function chargeReleased(merchantId: string, amount: number): Promise<string> {
  const intent = await intents.create({
    tenantId: org,
    merchantId,
    amount: Money.of(amount, 'COP'),
  });
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
    amount: Money.of(amount, 'COP'),
  });
  return intent.id;
}

async function balance(merchantId: string, code: 'merchant.available' | 'refund.liability') {
  const chart = await posting.ensureChart(org, merchantId, 'COP');
  return BigInt((await ledger.getBalance(org, chart[code])).available);
}

async function begin(s: RefundService, paymentIntentId: string, amount?: bigint) {
  return withTenantTransaction(ctx.app, org, (c) => s.beginIn(c, org, { paymentIntentId, amount }));
}

/** Refund llevado a `indeterminate` (throw del proveedor: la petición pudo salir). */
async function indeterminateRefund(paymentIntentId: string, amount?: bigint) {
  const s = svc(unknownOutcome);
  const r = await begin(s, paymentIntentId, amount);
  await s.execute(org, r.id);
  const row = await ctx.admin.query<{ status: string }>(
    `SELECT status FROM refunds WHERE id = $1`,
    [r.id]
  );
  expect(row.rows[0]!.status).toBe('indeterminate');
  return r;
}

async function refundsOf(paymentIntentId: string) {
  const res = await ctx.admin.query<{ id: string; amount: string; status: string }>(
    `SELECT id, amount::text, status FROM refunds WHERE payment_intent_id = $1 ORDER BY created_at, id`,
    [paymentIntentId]
  );
  return res.rows;
}

async function refundLedgerKeys(refundIds: string[]) {
  const res = await ctx.admin.query<{ idempotency_key: string }>(
    `SELECT idempotency_key FROM ledger_transactions
     WHERE tenant_id = $1 AND source_type = 'refund' AND source_id::text = ANY($2::text[])
     ORDER BY created_at, idempotency_key`,
    [org, refundIds]
  );
  return res.rows.map((r) => r.idempotency_key);
}

describe('indeterminate reserva cupo (servicio)', () => {
  it('full indeterminate ⇒ a second refund (full or any amount) is rejected; nothing new in the ledger', async () => {
    const m = await freshMerchant();
    const pi = await chargeReleased(m, 100_000);
    const r1 = await indeterminateRefund(pi);

    await expect(begin(svc(approve), pi)).rejects.toThrow(RefundAmountExceedsRemainingError);
    await expect(begin(svc(approve), pi, 1n)).rejects.toThrow(RefundAmountExceedsRemainingError);

    expect(await refundsOf(pi)).toEqual([{ id: r1.id, amount: '100000', status: 'indeterminate' }]);
    // Solo la reserva de r1: request; ni request ni settle de otro refund.
    expect(await refundLedgerKeys([r1.id])).toEqual([`refund:${r1.id}:request`]);
    expect(await balance(m, 'refund.liability')).toBe(100_000n);
    expect(await balance(m, 'merchant.available')).toBe(0n);
  });

  it('partial indeterminate (30%) ⇒ 80% is rejected, the exact 70% remainder fits', async () => {
    const m = await freshMerchant();
    await chargeReleased(m, 100_000); // saldo de OTRO cobro del mismo comercio
    const pi = await chargeReleased(m, 100_000);
    await indeterminateRefund(pi, 30_000n);

    const err = await begin(svc(approve), pi, 80_000n).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RefundAmountExceedsRemainingError);
    expect((err as RefundAmountExceedsRemainingError).remaining).toBe('70000');

    const r2 = await begin(svc(approve), pi);
    expect(r2.amount).toBe('70000'); // monto ausente = remanente VIVO
  });

  it('merchant with funds from OTHER charges: no double refund, and the verified resolution of the first still settles', async () => {
    const m = await freshMerchant();
    await chargeReleased(m, 100_000); // otro cobro: el ledger NO lo impediría
    const pi = await chargeReleased(m, 100_000);
    const r1 = await indeterminateRefund(pi);

    await expect(begin(svc(approve), pi)).rejects.toThrow(RefundAmountExceedsRemainingError);
    // Los fondos del otro cobro siguen intactos.
    expect(await balance(m, 'merchant.available')).toBe(100_000n);

    // La fuente verificada cierra r1 SIN chocar con el CHECK refunded ≤ captured
    // (antes del fix lanzaba y dejaba la reserva retenida para siempre).
    expect(
      await svc(approve).resolveFromProvider(org, {
        refundId: r1.id,
        result: 'succeeded',
        providerRef: 'mockr_verified',
      })
    ).toBe('applied');
    const intent = await intents.get(org, pi);
    expect(intent.status).toBe('refunded');
    expect(intent.amountRefunded).toBe('100000');
    expect(await balance(m, 'refund.liability')).toBe(0n);
    expect(await balance(m, 'merchant.available')).toBe(100_000n);
    expect(await refundLedgerKeys([r1.id])).toEqual([
      `refund:${r1.id}:request`,
      `refund:${r1.id}:settle`,
    ]);
  });

  it('verified FAILURE of the indeterminate refund returns the quota: a new refund fits again', async () => {
    const m = await freshMerchant();
    const pi = await chargeReleased(m, 50_000);
    const r1 = await indeterminateRefund(pi);
    await expect(begin(svc(approve), pi)).rejects.toThrow(RefundAmountExceedsRemainingError);

    await svc(approve).resolveFromProvider(org, {
      refundId: r1.id,
      result: 'failed',
      failureCode: 'refund_rejected',
    });
    const r2 = await begin(svc(approve), pi);
    expect(r2.amount).toBe('50000');
  });
});

describe('guard del motor (0048) — cualquier punto de entrada', () => {
  it('a direct INSERT with the app role cannot exceed the live remainder (indeterminate counts)', async () => {
    const m = await freshMerchant();
    await chargeReleased(m, 100_000);
    const pi = await chargeReleased(m, 100_000);
    await indeterminateRefund(pi, 60_000n);

    await expect(
      withTenantTransaction(ctx.app, org, (c) =>
        c.query(
          `INSERT INTO refunds (tenant_id, payment_intent_id, amount, currency, provider)
           VALUES ($1, $2, 40001, 'COP', 'mock')`,
          [org, pi]
        )
      )
    ).rejects.toThrow(/FLUVIA_REFUND_EXCEEDS_REMAINING/);
    // Exactamente el remanente sí cabe.
    await withTenantTransaction(ctx.app, org, (c) =>
      c.query(
        `INSERT INTO refunds (tenant_id, payment_intent_id, amount, currency, provider)
         VALUES ($1, $2, 40000, 'COP', 'mock')`,
        [org, pi]
      )
    );
  });

  it('refund amount / intent are immutable (the quota cannot be dodged by insert-small-then-update)', async () => {
    const m = await freshMerchant();
    const pi = await chargeReleased(m, 10_000);
    const r = await begin(svc(approve), pi, 1_000n);
    await expect(
      withTenantTransaction(ctx.app, org, (c) =>
        c.query(`UPDATE refunds SET amount = 999999 WHERE id = $1`, [r.id])
      )
    ).rejects.toThrow(/FLUVIA_REFUND_IMMUTABLE/);
  });

  it('two raw INSERTs racing on the same charge serialize on the intent row lock: the second is rejected', async () => {
    const m = await freshMerchant();
    const pi = await chargeReleased(m, 100_000);
    const c1 = await ctx.app.connect();
    const c2 = await ctx.app.connect();
    try {
      for (const c of [c1, c2]) {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [org]);
      }
      await c1.query(
        `INSERT INTO refunds (tenant_id, payment_intent_id, amount, currency, provider)
         VALUES ($1, $2, 100000, 'COP', 'mock')`,
        [org, pi]
      );
      // c2 queda BLOQUEADO en el FOR UPDATE del trigger hasta que c1 confirme.
      const second = c2
        .query(
          `INSERT INTO refunds (tenant_id, payment_intent_id, amount, currency, provider)
           VALUES ($1, $2, 100000, 'COP', 'mock')`,
          [org, pi]
        )
        .then(
          () => 'inserted',
          (e: Error) => e.message
        );
      await new Promise((r) => setTimeout(r, 150));
      await c1.query('COMMIT');
      expect(await second).toMatch(/^FLUVIA_REFUND_EXCEEDS_REMAINING/);
      await c2.query('ROLLBACK');
    } finally {
      c1.release();
      c2.release();
    }
    expect((await refundsOf(pi)).length).toBe(1);
  });
});

describe('concurrencia (servicio, PG real)', () => {
  it('two full refunds in parallel on the same charge: exactly one is created', async () => {
    for (let round = 0; round < 5; round++) {
      const m = await freshMerchant();
      const pi = await chargeReleased(m, 100_000);
      const s = svc(approve);
      const results = await Promise.allSettled([begin(s, pi), begin(s, pi)]);
      const ok = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(ok).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
        RefundAmountExceedsRemainingError
      );
      expect((await refundsOf(pi)).map((r) => r.amount)).toEqual(['100000']);
    }
  });

  it('ten partial refunds of 30% in parallel: exactly three fit, Σ live ≤ captured', async () => {
    const m = await freshMerchant();
    const pi = await chargeReleased(m, 100_000);
    const s = svc(approve);
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => begin(s, pi, 30_000n))
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    for (const r of results.filter((x) => x.status === 'rejected')) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(RefundAmountExceedsRemainingError);
    }
    const total = (await refundsOf(pi)).reduce((acc, r) => acc + BigInt(r.amount), 0n);
    expect(total).toBe(90_000n);
  });

  it('a new request racing the indeterminate transition never slips through', async () => {
    const m = await freshMerchant();
    await chargeReleased(m, 100_000);
    const pi = await chargeReleased(m, 100_000);
    const s1 = svc(unknownOutcome);
    const r1 = await begin(s1, pi);
    // r1 viaja created → processing → indeterminate mientras llegan solicitudes.
    const [, ...attempts] = await Promise.allSettled([
      s1.execute(org, r1.id),
      begin(svc(approve), pi),
      begin(svc(approve), pi, 1n),
    ]);
    for (const a of attempts) {
      expect(a.status).toBe('rejected');
      expect((a as PromiseRejectedResult).reason).toBeInstanceOf(RefundAmountExceedsRemainingError);
    }
    expect((await refundsOf(pi)).map((r) => r.status)).toEqual(['indeterminate']);
  });
});
