import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '@fluvia/db/testing';
import { LedgerService, PostingService } from '@fluvia/ledger';
import { Money } from '@fluvia/money';
import {
  CircuitOpenError,
  InsufficientPayoutBalanceError,
  MockPaymentProvider,
  PayoutService,
  ProviderTimeoutError,
  type PaymentProvider,
} from '../src/index.js';

/**
 * F4-07a — payouts como recurso gestionado (motor) sobre las primitivas
 * contables de F4-05b, vs Postgres real. Prueba el ciclo completo money-out con
 * balances exactos, la fundabilidad (pre-chequeo + guard atómico), y los
 * desenlaces conocido/desconocido con la resolución por fuente verificada.
 *
 * Cada test usa un TENANT nuevo: las cuentas platform-scope (payout.in_transit,
 * platform.cash) son por tenant, así que los balances no se cruzan entre casos.
 */

let ctx: TestContext;
let posting: PostingService;
let payouts: PayoutService;

const cop = (n: number) => Money.of(n, 'COP');

beforeAll(async () => {
  ctx = await createTestContext();
  posting = new PostingService(new LedgerService(ctx.app), ctx.app);
  payouts = new PayoutService(ctx.app, posting, new MockPaymentProvider());
}, 30_000);

afterAll(async () => {
  await ctx.close();
});

/** Tenant + comercio nuevos: aislamiento total de balances (incl. platform). */
async function scenario(): Promise<{ org: string; m: string }> {
  const org = await ctx.createTenant(`Payout ${randomUUID().slice(0, 8)}`);
  const res = await ctx.admin.query<{ id: string }>(
    `INSERT INTO merchants (tenant_id, name) VALUES ($1, $2) RETURNING id`,
    [org, `po-shop-${randomUUID().slice(0, 8)}`]
  );
  return { org, m: res.rows[0]!.id };
}

/**
 * Siembra el estado money-IN completo antes del payout (money-OUT), como en
 * real: captura (provider.clearing + merchant.pending) -> el proveedor liquida a
 * la caja de Fluvia (receiveProviderSettlement: platform.cash += X) -> liberación
 * a disponible (releaseSettlement: pending -> available). Deja
 * `merchant.available = X` Y `platform.cash = X` (el payout descarga el
 * disponible contra esa caja: sin caja no hay con qué pagar — guard F4-05b).
 */
async function seedAvailable(org: string, merchantId: string, amount: number): Promise<void> {
  const src = randomUUID();
  await posting.capturePayment({
    tenantId: org,
    merchantId,
    idempotencyKey: `cap:${src}`,
    sourceType: 'payment_attempt',
    sourceId: src,
    amount: cop(amount),
  });
  await posting.receiveProviderSettlement({
    tenantId: org,
    merchantId,
    idempotencyKey: `prov:${src}`,
    sourceType: 'settlement',
    sourceId: src,
    amount: cop(amount),
  });
  await posting.releaseSettlement({
    tenantId: org,
    merchantId,
    idempotencyKey: `settle:${src}`,
    sourceType: 'settlement',
    sourceId: src,
    amount: cop(amount),
  });
}

/** Saldo (bucket available) de una cuenta por nombre. Merchant-scope = code:mid. */
async function bal(org: string, name: string): Promise<bigint> {
  const res = await ctx.admin.query<{ available: string }>(
    `SELECT COALESCE(bp.available, 0)::text AS available
     FROM ledger_accounts la
     JOIN balance_projections bp ON bp.account_id = la.id
     WHERE la.tenant_id = $1 AND la.name = $2 AND la.currency = 'COP'`,
    [org, name]
  );
  return BigInt(res.rows[0]?.available ?? '0');
}
const available = (org: string, m: string) => bal(org, `merchant.available:${m}`);

async function payoutRow(id: string) {
  const res = await ctx.admin.query<{
    status: string;
    failure_code: string | null;
    provider_ref: string | null;
    resolved_at: Date | null;
  }>(`SELECT status, failure_code, provider_ref, resolved_at FROM payouts WHERE id = $1`, [id]);
  return res.rows[0]!;
}

/** Nº de asientos contables enlazados a este payout (emit/settle/fail). */
async function ledgerTxCount(payoutId: string): Promise<number> {
  const res = await ctx.admin.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM ledger_transactions
     WHERE source_type = 'payout' AND source_id = $1`,
    [payoutId]
  );
  return Number(res.rows[0]!.n);
}

function withProvider(submitPayout: PaymentProvider['submitPayout']): PayoutService {
  const provider: PaymentProvider = {
    name: 'mock',
    submitPayment: () => Promise.reject(new Error('not used')),
    submitPayout,
  };
  return new PayoutService(ctx.app, posting, provider);
}

describe('PayoutService — ciclo money-out (F4-07a)', () => {
  it('happy path: request -> emit -> paid, con balances exactos + cero drift', async () => {
    const { org, m } = await scenario();
    await seedAvailable(org, m, 100_000);
    // Tras la siembra, Fluvia tiene la caja del proveedor con qué pagar.
    expect(await bal(org, 'platform.cash')).toBe(100_000n);

    const po = await payouts.create(org, { merchantId: m, amount: 100_000n, currency: 'COP' });
    expect(po.status).toBe('requested');
    expect(po.amount).toBe('100000');

    await payouts.execute(org, po.id);

    const row = await payoutRow(po.id);
    expect(row.status).toBe('paid');
    expect(row.provider_ref).toMatch(/^mockp_/);
    expect(row.resolved_at).not.toBeNull();

    // El disponible salió del comercio y la caja se descargó al pagar al banco:
    // Fluvia recibió 100k del proveedor y pagó 100k al comercio ⇒ caja neta 0.
    expect(await available(org, m)).toBe(0n);
    expect(await bal(org, 'payout.in_transit')).toBe(0n);
    expect(await bal(org, 'platform.cash')).toBe(0n);

    // emit + settle = 2 asientos, ni uno más.
    expect(await ledgerTxCount(po.id)).toBe(2);
  });

  it('fundabilidad: dos payouts `requested` no pueden exceder el disponible en conjunto', async () => {
    const { org, m } = await scenario();
    await seedAvailable(org, m, 100_000);

    const p1 = await payouts.create(org, { merchantId: m, amount: 60_000n, currency: 'COP' });
    const p2 = await payouts.create(org, { merchantId: m, amount: 40_000n, currency: 'COP' });
    // El disponible ya está comprometido por p1+p2: un tercero no cabe.
    await expect(
      payouts.create(org, { merchantId: m, amount: 1n, currency: 'COP' })
    ).rejects.toBeInstanceOf(InsufficientPayoutBalanceError);

    await payouts.execute(org, p1.id);
    await payouts.execute(org, p2.id);
    expect((await payoutRow(p1.id)).status).toBe('paid');
    expect((await payoutRow(p2.id)).status).toBe('paid');
    expect(await available(org, m)).toBe(0n);
    // 100k recibidos del proveedor, 60k+40k pagados al banco ⇒ caja neta 0.
    expect(await bal(org, 'platform.cash')).toBe(0n);
  });

  it('create rechaza un payout que excede el disponible', async () => {
    const { org, m } = await scenario();
    await seedAvailable(org, m, 50_000);
    await expect(
      payouts.create(org, { merchantId: m, amount: 50_001n, currency: 'COP' })
    ).rejects.toBeInstanceOf(InsufficientPayoutBalanceError);
  });

  it('carrera: el disponible se drena antes del emit -> failed sin mover dinero', async () => {
    const { org, m } = await scenario();
    await seedAvailable(org, m, 100_000);
    const po = await payouts.create(org, { merchantId: m, amount: 100_000n, currency: 'COP' });

    // Otra operación vacía el disponible entre la validación y el emit.
    await posting.emitPayout({
      tenantId: org,
      merchantId: m,
      idempotencyKey: `drain:${po.id}`,
      sourceType: 'payout',
      sourceId: `drain-${po.id}`,
      amount: cop(100_000),
    });
    expect(await available(org, m)).toBe(0n);

    await payouts.execute(org, po.id);
    const row = await payoutRow(po.id);
    expect(row.status).toBe('failed');
    expect(row.failure_code).toBe('insufficient_merchant_balance');
    // El payout NO posteó ningún asiento (el banco jamás fue contactado).
    expect(await ledgerTxCount(po.id)).toBe(0);
    expect(await available(org, m)).toBe(0n);
  });

  it('rechazo del banco -> failed y los fondos vuelven ÍNTEGROS al comercio', async () => {
    const { org, m } = await scenario();
    await seedAvailable(org, m, 80_000);
    const svc = withProvider(() =>
      Promise.resolve({ outcome: 'declined', providerRef: 'mockp_x', failureCode: 'bank_rejected' })
    );
    const po = await svc.create(org, { merchantId: m, amount: 80_000n, currency: 'COP' });
    await svc.execute(org, po.id);

    const row = await payoutRow(po.id);
    expect(row.status).toBe('failed');
    expect(row.failure_code).toBe('bank_rejected');
    // emit sacó y failPayout devolvió: disponible restaurado, nada en tránsito.
    // El settle nunca ocurrió ⇒ la caja del proveedor sigue intacta (Fluvia
    // conserva el dinero, el payout no salió).
    expect(await available(org, m)).toBe(80_000n);
    expect(await bal(org, 'payout.in_transit')).toBe(0n);
    expect(await bal(org, 'platform.cash')).toBe(80_000n);
  });

  it('desenlace desconocido (timeout) -> indeterminate; SOLO fuente verificada lo cierra', async () => {
    const { org, m } = await scenario();
    await seedAvailable(org, m, 90_000);
    const svc = withProvider(() => Promise.reject(new ProviderTimeoutError('mock')));
    const po = await svc.create(org, { merchantId: m, amount: 90_000n, currency: 'COP' });
    await svc.execute(org, po.id);

    // Fondos RETENIDOS en tránsito; nada resuelto por asunción.
    expect((await payoutRow(po.id)).status).toBe('indeterminate');
    expect(await available(org, m)).toBe(0n);
    expect(await bal(org, 'payout.in_transit')).toBe(90_000n);

    // Un evento tardío para un payout inexistente no rompe nada.
    expect(await svc.resolveFromProvider(org, { payoutId: randomUUID(), result: 'paid' })).toBe(
      'ignored'
    );

    // Fuente verificada: el banco confirmó.
    const outcome = await svc.resolveFromProvider(org, {
      payoutId: po.id,
      result: 'paid',
      providerRef: 'mockp_confirmed',
    });
    expect(outcome).toBe('applied');
    expect((await payoutRow(po.id)).status).toBe('paid');
    expect(await bal(org, 'payout.in_transit')).toBe(0n);
    // 90k recibidos del proveedor, 90k pagados al banco ⇒ caja neta 0.
    expect(await bal(org, 'platform.cash')).toBe(0n);

    // Re-resolver un payout ya terminal es un evento fuera de orden.
    expect(await svc.resolveFromProvider(org, { payoutId: po.id, result: 'failed' })).toBe(
      'ignored_out_of_order'
    );
  });

  it('circuito abierto: jamás se envió -> failed provider_unavailable, fondos de vuelta', async () => {
    const { org, m } = await scenario();
    await seedAvailable(org, m, 40_000);
    const svc = withProvider(() => Promise.reject(new CircuitOpenError('mock', 30_000)));
    const po = await svc.create(org, { merchantId: m, amount: 40_000n, currency: 'COP' });
    await svc.execute(org, po.id);

    const row = await payoutRow(po.id);
    expect(row.status).toBe('failed');
    expect(row.failure_code).toBe('provider_unavailable');
    expect(await available(org, m)).toBe(40_000n);
    expect(await bal(org, 'payout.in_transit')).toBe(0n);
  });

  it('idempotencia: re-ejecutar un payout ya pagado no vuelve a mover dinero', async () => {
    const { org, m } = await scenario();
    await seedAvailable(org, m, 25_000);
    const po = await payouts.create(org, { merchantId: m, amount: 25_000n, currency: 'COP' });
    await payouts.execute(org, po.id);
    await payouts.execute(org, po.id); // replay: terminal, no-op.

    expect((await payoutRow(po.id)).status).toBe('paid');
    expect(await ledgerTxCount(po.id)).toBe(2); // emit + settle, sin duplicar.
    expect(await bal(org, 'platform.cash')).toBe(0n); // 25k recibidos, 25k pagados.
    expect(await available(org, m)).toBe(0n);
  });
});
