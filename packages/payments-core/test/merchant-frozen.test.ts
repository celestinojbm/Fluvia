import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenantTransaction } from '@fluvia/db';
import { createTestContext, type TestContext } from '@fluvia/db/testing';
import { LedgerService, PostingService } from '@fluvia/ledger';
import { Money } from '@fluvia/money';
import {
  MERCHANT_FROZEN_SQLSTATE,
  MockPaymentProvider,
  PaymentConfirmationService,
  PaymentIntentService,
  PayoutService,
  RefundService,
  ZERO_FEE_SCHEDULE,
  isMerchantFrozenDbError,
  type PaymentProvider,
} from '../src/index.js';

/**
 * #92 — `merchants.status = 'frozen'` hecho cumplir por el MOTOR (0069).
 *
 * Antes de 0069 el estado existía pero ningún servicio lo leía: un comercio
 * congelado seguía cobrando y cobrando payouts. Se prueba por los servicios
 * reales que crear intents, confirmar y emitir payouts falla con FV453, que lo
 * ya en vuelo y los refunds siguen, y que descongelar restaura el flujo.
 *
 * Congelar es plano de plataforma (`MerchantRiskAdmin` en @fluvia/identity);
 * aquí se hace con el pool admin para no acoplar paquetes, igual que el CLI.
 */

let ctx: TestContext;
let intents: PaymentIntentService;
let posting: PostingService;

const cop = (n: number) => Money.of(n, 'COP');

beforeAll(async () => {
  ctx = await createTestContext();
  intents = new PaymentIntentService(ctx.app);
  posting = new PostingService(new LedgerService(ctx.app), ctx.app);
}, 30_000);

afterAll(async () => {
  await ctx.close();
});

async function scenario(): Promise<{ org: string; m: string }> {
  const org = await ctx.createTenant(`FZ ${randomUUID().slice(0, 8)}`);
  const res = await ctx.admin.query<{ id: string }>(
    `INSERT INTO merchants (tenant_id, name, state_affiliation) VALUES ($1, $2, 'none') RETURNING id`,
    [org, `fz-shop-${randomUUID().slice(0, 8)}`]
  );
  return { org, m: res.rows[0]!.id };
}

const setStatus = (m: string, status: 'active' | 'frozen') =>
  ctx.admin.query(`UPDATE merchants SET status = $2 WHERE id = $1`, [m, status]);

async function expectFrozen(p: Promise<unknown>): Promise<void> {
  const err = await p.then(
    () => null,
    (e: unknown) => e
  );
  expect(err, 'expected the engine to block a frozen merchant').not.toBeNull();
  expect(isMerchantFrozenDbError(err)).toBe(true);
  expect((err as { code: string }).code).toBe(MERCHANT_FROZEN_SQLSTATE);
}

function countingProvider(): PaymentProvider & { payouts: number } {
  const inner = new MockPaymentProvider();
  const p = {
    name: 'mock',
    payouts: 0,
    submitPayment: (i: Parameters<PaymentProvider['submitPayment']>[0]) => inner.submitPayment(i),
    refundPayment: (i: Parameters<NonNullable<PaymentProvider['refundPayment']>>[0]) =>
      inner.refundPayment(i),
    submitPayout: (i: Parameters<NonNullable<PaymentProvider['submitPayout']>>[0]) => {
      p.payouts += 1;
      return inner.submitPayout(i);
    },
  };
  return p;
}

const confirmation = () =>
  new PaymentConfirmationService(
    ctx.app,
    intents,
    posting,
    new MockPaymentProvider(),
    ZERO_FEE_SCHEDULE
  );

/** Deja `merchant.available = amount` y la caja de plataforma para pagarlo. */
async function seedAvailable(org: string, merchantId: string, amount: number): Promise<void> {
  const src = randomUUID();
  const base = { tenantId: org, merchantId, sourceId: src, amount: cop(amount) };
  await posting.capturePayment({
    ...base,
    idempotencyKey: `cap:${src}`,
    sourceType: 'payment_attempt',
  });
  await posting.receiveProviderSettlement({
    ...base,
    idempotencyKey: `prov:${src}`,
    sourceType: 'settlement',
  });
  await posting.releaseSettlement({
    ...base,
    idempotencyKey: `settle:${src}`,
    sourceType: 'settlement',
  });
}

describe('comercio congelado: el motor corta el dinero nuevo', () => {
  it('no nacen intents y no queda nada a medias; otro comercio sigue cobrando', async () => {
    const frozen = await scenario();
    const other = await scenario();
    await setStatus(frozen.m, 'frozen');

    await expectFrozen(
      intents.create({ tenantId: frozen.org, merchantId: frozen.m, amount: cop(10_000) })
    );
    const rows = await ctx.admin.query(`SELECT 1 FROM payment_intents WHERE merchant_id = $1`, [
      frozen.m,
    ]);
    expect(rows.rowCount).toBe(0);

    const ok = await intents.create({
      tenantId: other.org,
      merchantId: other.m,
      amount: cop(10_000),
    });
    expect(ok.status).toBe('created');
  });

  it('confirmar un intent creado ANTES de congelar falla y deja el intent intacto', async () => {
    const { org, m } = await scenario();
    const intent = await intents.create({ tenantId: org, merchantId: m, amount: cop(20_000) });
    await setStatus(m, 'frozen');

    await expectFrozen(
      withTenantTransaction(ctx.app, org, (c) => confirmation().beginIn(c, org, intent.id))
    );
    expect((await intents.get(org, intent.id)).status).toBe('created');
    const attempts = await ctx.admin.query(`SELECT 1 FROM payment_attempts WHERE intent_id = $1`, [
      intent.id,
    ]);
    expect(attempts.rowCount).toBe(0);
  });

  it('no se piden payouts nuevos aunque haya saldo disponible', async () => {
    const { org, m } = await scenario();
    await seedAvailable(org, m, 30_000);
    await setStatus(m, 'frozen');
    const payouts = new PayoutService(ctx.app, posting, countingProvider());
    await expectFrozen(payouts.create(org, { merchantId: m, amount: 1_000n, currency: 'COP' }));
  });

  it('payout `requested` ANTES de congelar: execute/re-drive NO lo envía al banco y falla limpio', async () => {
    const { org, m } = await scenario();
    await seedAvailable(org, m, 40_000);
    const provider = countingProvider();
    const payouts = new PayoutService(ctx.app, posting, provider);
    const p = await payouts.create(org, { merchantId: m, amount: 15_000n, currency: 'COP' });
    await setStatus(m, 'frozen');

    await payouts.execute(org, p.id); // lo que haría el redriver al vencer el lease
    expect(provider.payouts).toBe(0);
    const after = await payouts.get(org, p.id);
    expect(after.status).toBe('failed');
    expect(after.failureCode).toBe('merchant_frozen');
    await payouts.execute(org, p.id); // terminal: no-op, sin bucle para el redriver
    expect(provider.payouts).toBe(0);
  });

  it('el motor impide requested→in_transit aunque un servicio no lo sepa', async () => {
    const { org, m } = await scenario();
    await seedAvailable(org, m, 10_000);
    const payouts = new PayoutService(ctx.app, posting, countingProvider());
    const p = await payouts.create(org, { merchantId: m, amount: 5_000n, currency: 'COP' });
    await setStatus(m, 'frozen');
    await expectFrozen(
      ctx.admin.query(`UPDATE payouts SET status = 'in_transit' WHERE id = $1`, [p.id])
    );
  });
});

describe('comercio congelado: lo que NO se corta', () => {
  it('un attempt enviado antes de congelar se sigue capturando (hecho del proveedor)', async () => {
    const { org, m } = await scenario();
    const conf = confirmation();
    const intent = await intents.create({ tenantId: org, merchantId: m, amount: cop(15_000) });
    const { attemptId } = await withTenantTransaction(ctx.app, org, (c) =>
      conf.beginIn(c, org, intent.id)
    );
    await setStatus(m, 'frozen');
    await conf.execute(org, attemptId, 'tok_approve');
    expect((await intents.get(org, intent.id)).status).toBe('succeeded');
  });

  it('los refunds siguen: devolver el dinero es la salida ordenada', async () => {
    const { org, m } = await scenario();
    const conf = confirmation();
    const intent = await intents.create({ tenantId: org, merchantId: m, amount: cop(12_000) });
    const { attemptId } = await withTenantTransaction(ctx.app, org, (c) =>
      conf.beginIn(c, org, intent.id)
    );
    await conf.execute(org, attemptId, 'tok_approve');
    // Mismo sembrado que refunds.test (seedSucceeded): lo capturado se libera
    // al disponible, para que el único motivo posible de fallo sea la congelación.
    await posting.releaseSettlement({
      tenantId: org,
      merchantId: m,
      idempotencyKey: `settle:${intent.id}`,
      sourceType: 'settlement',
      sourceId: intent.id,
      amount: cop(12_000),
    });
    await setStatus(m, 'frozen');

    const refunds = new RefundService(ctx.app, intents, posting, new MockPaymentProvider());
    const refund = await withTenantTransaction(ctx.app, org, (c) =>
      refunds.beginIn(c, org, { paymentIntentId: intent.id, amount: 2_000n })
    );
    await refunds.execute(org, refund.id);
    expect((await refunds.get(org, refund.id)).status).toBe('succeeded');
  });

  it('descongelar restaura el flujo', async () => {
    const { org, m } = await scenario();
    await setStatus(m, 'frozen');
    await expectFrozen(intents.create({ tenantId: org, merchantId: m, amount: cop(1_000) }));
    await setStatus(m, 'active');
    const ok = await intents.create({ tenantId: org, merchantId: m, amount: cop(1_000) });
    expect(ok.status).toBe('created');
  });

  it('un legado sin declaración queda pending_review, activo, y puede cobrar', async () => {
    const org = await ctx.createTenant(`FZ ${randomUUID().slice(0, 8)}`);
    const res = await ctx.admin.query<{
      id: string;
      status: string;
      affiliation_declaration_status: string;
    }>(
      `INSERT INTO merchants (tenant_id, name) VALUES ($1, $2)
       RETURNING id, status, affiliation_declaration_status`,
      [org, `legado-${randomUUID().slice(0, 8)}`]
    );
    const row = res.rows[0]!;
    expect(row.status).toBe('active');
    expect(row.affiliation_declaration_status).toBe('pending_review');
    const ok = await intents.create({ tenantId: org, merchantId: row.id, amount: cop(1_000) });
    expect(ok.status).toBe('created');
  });
});
