import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenantTransaction } from '@fluvia/db';
import { createTestContext, type TestContext } from '@fluvia/db/testing';
import { LedgerService, PostingService } from '@fluvia/ledger';
import { Money } from '@fluvia/money';
import {
  FlatBpsFeeSchedule,
  MockPaymentProvider,
  PaymentConfirmationService,
  PaymentIntentService,
  RefundService,
} from '../src/index.js';

/**
 * CARACTERIZACIÓN (no cambia reglas monetarias): por qué `merchant.available`
 * no recibe los fondos de un cobro en el flujo de producto y qué le pasa a una
 * devolución. Ver docs/architecture/refund-settlement-sandbox-proposal.md.
 *
 * Flujo de producto = confirmación (API/checkout/POS) con el fee de producción
 * (2%, 200 bps). La captura acredita `merchant.pending` = M − Ff; NINGÚN
 * proceso de producto invoca `releaseSettlement` (solo seed, drills y tests),
 * así que `merchant.available` se queda en 0 y la devolución se CANCELA en la
 * reserva (guard de no-negatividad) sin contactar al proveedor.
 */

let ctx: TestContext;
let intents: PaymentIntentService;
let posting: PostingService;
let ledger: LedgerService;
let confirmation: PaymentConfirmationService;
let org: string;

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
    new FlatBpsFeeSchedule(200) // el default de producción (PLATFORM_FEE_BPS)
  );
  org = await ctx.createTenant(`SettleGap ${randomUUID().slice(0, 8)}`);
}, 30_000);

afterAll(async () => {
  await ctx.close();
});

async function freshMerchant(): Promise<string> {
  const m = await ctx.admin.query<{ id: string }>(
    `INSERT INTO merchants (tenant_id, name) VALUES ($1, $2) RETURNING id`,
    [org, `gap-${randomUUID().slice(0, 8)}`]
  );
  return m.rows[0]!.id;
}

async function charge(merchantId: string, amount: number): Promise<string> {
  const intent = await intents.create({
    tenantId: org,
    merchantId,
    amount: Money.of(amount, 'COP'),
  });
  const { attemptId } = await withTenantTransaction(ctx.app, org, (c) =>
    confirmation.beginIn(c, org, intent.id)
  );
  await confirmation.execute(org, attemptId, 'tok_approve');
  return intent.id;
}

async function balances(merchantId: string) {
  const chart = await posting.ensureChart(org, merchantId, 'COP');
  const read = async (code: keyof typeof chart) =>
    BigInt((await ledger.getBalance(org, chart[code])).available);
  return {
    pending: await read('merchant.pending'),
    available: await read('merchant.available'),
    liability: await read('refund.liability'),
  };
}

async function refundOnce(paymentIntentId: string) {
  const svc = new RefundService(ctx.app, intents, posting, new MockPaymentProvider());
  const r = await withTenantTransaction(ctx.app, org, (c) =>
    svc.beginIn(c, org, { paymentIntentId })
  );
  await svc.execute(org, r.id);
  const row = await ctx.admin.query<{ status: string; failure_code: string | null }>(
    `SELECT status, failure_code FROM refunds WHERE id = $1`,
    [r.id]
  );
  return row.rows[0]!;
}

describe('liquidación: dónde se quedan los fondos del cobro (estado actual)', () => {
  it('capture credits merchant.pending = M − Ff; available stays 0; refund is canceled at reservation', async () => {
    const m = await freshMerchant();
    const pi = await charge(m, 100_000);

    const intent = await intents.get(org, pi);
    expect(intent.status).toBe('succeeded');
    expect(intent.amountCaptured).toBe('100000'); // BRUTO: base del cupo devolvible
    expect(await balances(m)).toEqual({ pending: 98_000n, available: 0n, liability: 0n });

    // El cupo (bruto) permite pedir 100.000, pero la reserva sale de available = 0.
    expect(await refundOnce(pi)).toEqual({
      status: 'canceled',
      failure_code: 'insufficient_merchant_balance',
    });
    expect(await balances(m)).toEqual({ pending: 98_000n, available: 0n, liability: 0n });
  });

  it('even after a sandbox release of the NET amount, a full GROSS refund does not fit (Ff gap)', async () => {
    const m = await freshMerchant();
    const pi = await charge(m, 100_000);
    // Liberación sandbox del neto que realmente se acreditó (M − Ff).
    await posting.releaseSettlement({
      tenantId: org,
      merchantId: m,
      idempotencyKey: `settle:${pi}`,
      sourceType: 'settlement',
      sourceId: pi,
      amount: Money.of(98_000, 'COP'),
    });
    expect(await balances(m)).toEqual({ pending: 0n, available: 98_000n, liability: 0n });

    // Devolución total = bruto 100.000 > neto disponible 98.000.
    expect(await refundOnce(pi)).toEqual({
      status: 'canceled',
      failure_code: 'insufficient_merchant_balance',
    });
  });
});
