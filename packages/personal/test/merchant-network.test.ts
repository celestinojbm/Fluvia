import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenantTransaction } from '@fluvia/db';
import { LedgerService, PostingService } from '@fluvia/ledger';
import { Money } from '@fluvia/money';
import {
  MockPaymentProvider,
  PaymentConfirmationService,
  PaymentIntentService,
  RefundService,
  SqlProviderOperationStore,
  UncertainPaymentResolver,
  ZERO_FEE_SCHEDULE,
} from '@fluvia/payments-core';
import { FluviaCardNetwork, FluviaRoutingProvider } from '../src/index.js';
import { bal, creditReady, harness, type Harness } from './helpers.js';

/**
 * Compra en un comercio Fluvia con un código de Fluvia Personal: el comercio
 * (otra organización) cobra por su flujo de siempre y el proveedor de
 * enrutamiento manda el código a la red Fluvia → emisor del programa.
 * Incluye la pérdida de respuesta (cobro y devolución inciertos) y su
 * resolución por consulta verificable.
 */
let h: Harness;
let merchantOrg: string;
let merchantId: string;
let intents: PaymentIntentService;
let posting: PostingService;
let confirmation: PaymentConfirmationService;
let refunds: RefundService;
let resolver: UncertainPaymentResolver;
const dropped = new Set<string>();

beforeAll(async () => {
  h = await harness();
  merchantOrg = await h.ctx.createTenant(`Bodega ${randomUUID().slice(0, 6)}`);
  const m = await h.ctx.admin.query<{ id: string }>(
    `INSERT INTO merchants (tenant_id, name, default_currency) VALUES ($1, 'Bodega La Esquina', 'VES') RETURNING id`,
    [merchantOrg]
  );
  merchantId = m.rows[0]!.id;
  const network = new FluviaCardNetwork(h.program, h.s.authorizations, {
    dropResponse: (_op, ref) => dropped.has(ref),
  });
  const provider = new FluviaRoutingProvider(
    new MockPaymentProvider(new SqlProviderOperationStore(h.ctx.app)),
    network
  );
  intents = new PaymentIntentService(h.ctx.app);
  posting = new PostingService(new LedgerService(h.ctx.app), h.ctx.app);
  confirmation = new PaymentConfirmationService(
    h.ctx.app,
    intents,
    posting,
    provider,
    ZERO_FEE_SCHEDULE
  );
  refunds = new RefundService(h.ctx.app, intents, posting, provider);
  resolver = new UncertainPaymentResolver(h.ctx.app, provider, confirmation, refunds);
}, 60_000);

afterAll(async () => {
  await h.close();
});

async function charge(amount: bigint, token: string, drop = false) {
  const intent = await intents.create({
    tenantId: merchantOrg,
    merchantId,
    amount: Money.of(amount, 'VES'),
  });
  const { attemptId } = await withTenantTransaction(h.ctx.app, merchantOrg, (c) =>
    confirmation.beginIn(c, merchantOrg, intent.id)
  );
  if (drop) dropped.add(attemptId);
  await confirmation.execute(merchantOrg, attemptId, token);
  const st = await h.ctx.admin.query<{ status: string }>(
    `SELECT status FROM payment_intents WHERE id = $1`,
    [intent.id]
  );
  return { intentId: intent.id, attemptId, status: st.rows[0]!.status };
}

async function releaseToMerchant(intentId: string, amount: bigint) {
  await posting.releaseSettlement({
    tenantId: merchantOrg,
    merchantId,
    idempotencyKey: `settle:${intentId}`,
    sourceType: 'settlement',
    sourceId: intentId,
    amount: Money.of(amount, 'VES'),
  });
}

async function refund(intentId: string, amount: bigint, drop = false) {
  const r = await withTenantTransaction(h.ctx.app, merchantOrg, (c) =>
    refunds.beginIn(c, merchantOrg, { paymentIntentId: intentId, amount })
  );
  if (drop) dropped.add(r.id);
  await refunds.execute(merchantOrg, r.id);
  const st = await h.ctx.admin.query<{ status: string }>(
    `SELECT status FROM refunds WHERE id = $1`,
    [r.id]
  );
  return { refundId: r.id, status: st.rows[0]!.status };
}

describe('compra en comercio Fluvia con código de Fluvia Personal', () => {
  it('cuotas: el comercio cobra el total; el cliente debe el financiado; devolución parcial ajusta la deuda', async () => {
    const c = await creditReady(h, {
      funds: 1_400_000n,
      collateral: 1_000_000n,
      requested: 3_000_000n,
    });
    const code = await h.s.cards.createPaymentCode(
      h.program,
      c.id,
      { cardId: c.card.id, mode: 'installments', installmentsCount: 3 },
      c.actor
    );
    const ch = await charge(400_000n, code.code);
    expect(ch.status).toBe('succeeded');
    // Lado comercio: cobro capturado por su flujo normal (pendiente de liquidar).
    const chart = await posting.ensureChart(merchantOrg, merchantId, 'VES');
    const pending = await h.ctx.admin.query<{ available: string }>(
      `SELECT available::text FROM balance_projections WHERE account_id = $1`,
      [chart['merchant.pending']]
    );
    expect(BigInt(pending.rows[0]!.available)).toBeGreaterThanOrEqual(400_000n);
    // Lado programa: inicial 100k de saldo propio, 300k de deuda en 3 cuotas.
    let b = await bal(h, c.id);
    expect(b.debt).toBe(300_000n);
    expect(b.available).toBe(300_000n);
    const plans = await h.s.credit.listPlans(h.program, c.id, c.id);
    expect(plans[0]!.merchantName).toBe('Bodega La Esquina');
    expect(plans[0]!.installments).toHaveLength(3);

    // Devolución parcial desde el comercio ⇒ red ⇒ emisor.
    await releaseToMerchant(ch.intentId, 400_000n);
    const r = await refund(ch.intentId, 150_000n);
    expect(r.status).toBe('succeeded');
    b = await bal(h, c.id);
    expect(b.debt).toBe(150_000n);
  });

  it('cobro con respuesta perdida: el comercio queda incierto, la consulta verificable lo resuelve', async () => {
    const c = await creditReady(h, {
      funds: 1_500_000n,
      collateral: 1_000_000n,
      requested: 3_000_000n,
    });
    const code = await h.s.cards.createPaymentCode(
      h.program,
      c.id,
      { cardId: c.card.id, mode: 'wallet' },
      c.actor
    );
    const ch = await charge(120_000n, code.code, true);
    expect(ch.status).toBe('processing');
    const att = await h.ctx.admin.query<{ status: string }>(
      `SELECT status FROM payment_attempts WHERE id = $1`,
      [ch.attemptId]
    );
    expect(att.rows[0]!.status).toBe('indeterminate');
    // El emisor sí capturó: el cliente ya pagó (sin doble cargo al resolver).
    expect((await bal(h, c.id)).available).toBe(380_000n);
    const res = await resolver.resolveTenant(merchantOrg);
    expect(res.attempts.resolved).toBeGreaterThanOrEqual(1);
    const st = await h.ctx.admin.query<{ status: string }>(
      `SELECT status FROM payment_intents WHERE id = $1`,
      [ch.intentId]
    );
    expect(st.rows[0]!.status).toBe('succeeded');
    expect((await bal(h, c.id)).available).toBe(380_000n);
  });

  it('devolución con respuesta perdida: queda incierta con reserva y se resuelve por consulta', async () => {
    const c = await creditReady(h, {
      funds: 1_500_000n,
      collateral: 1_000_000n,
      requested: 3_000_000n,
    });
    const code = await h.s.cards.createPaymentCode(
      h.program,
      c.id,
      { cardId: c.card.id, mode: 'wallet' },
      c.actor
    );
    const ch = await charge(200_000n, code.code);
    await releaseToMerchant(ch.intentId, 200_000n);
    const r = await refund(ch.intentId, 200_000n, true);
    // Interno `indeterminate` (el comercio ve `processing`) con la reserva retenida.
    expect(r.status).toBe('indeterminate');
    const res = await resolver.resolveTenant(merchantOrg);
    expect(res.refunds.resolved).toBeGreaterThanOrEqual(1);
    const after = await h.ctx.admin.query<{ status: string }>(
      `SELECT status FROM refunds WHERE id = $1`,
      [r.refundId]
    );
    expect(after.rows[0]!.status).toBe('succeeded');
    expect((await bal(h, c.id)).available).toBe(500_000n);
  });

  it('devolución incierta del MockProvider (cargo de prueba) también se resuelve por consulta', async () => {
    const ch = await charge(50_000n, 'tok_approve_refund_timeout');
    expect(ch.status).toBe('succeeded');
    await releaseToMerchant(ch.intentId, 50_000n);
    const r = await refund(ch.intentId, 20_000n);
    expect(r.status).toBe('indeterminate');
    const res = await resolver.resolveTenant(merchantOrg);
    expect(res.refunds.resolved).toBeGreaterThanOrEqual(1);
    const after = await h.ctx.admin.query<{ status: string }>(
      `SELECT status FROM refunds WHERE id = $1`,
      [r.refundId]
    );
    expect(after.rows[0]!.status).toBe('succeeded');
  });

  it('código inválido o fondos insuficientes: el comercio ve el rechazo, sin efectos en el cliente', async () => {
    const bad = await charge(10_000n, 'fcp_' + 'f'.repeat(64));
    expect(bad.status).toBe('failed');
    const c = await creditReady(h, {
      funds: 1_000_000n,
      collateral: 1_000_000n,
      requested: 3_000_000n,
    });
    const code = await h.s.cards.createPaymentCode(
      h.program,
      c.id,
      { cardId: c.card.id, mode: 'wallet' },
      c.actor
    );
    const poor = await charge(10_000n, code.code);
    expect(poor.status).toBe('failed');
    const reason = await h.ctx.admin.query<{ failure_code: string }>(
      `SELECT failure_code FROM payment_intents WHERE id = $1`,
      [poor.intentId]
    );
    expect(reason.rows[0]!.failure_code).toBe('insufficient_funds');
    expect((await bal(h, c.id)).held).toBe(0n);
  });
});
