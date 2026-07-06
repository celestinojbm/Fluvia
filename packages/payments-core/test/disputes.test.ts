import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '@fluvia/db/testing';
import { LedgerService, PostingService } from '@fluvia/ledger';
import { Money } from '@fluvia/money';
import {
  DisputeNotFoundError,
  DisputeService,
  InsufficientDisputeBalanceError,
} from '../src/index.js';

/**
 * F4-08a — disputas/chargebacks como recurso gestionado (motor) sobre
 * `dispute.reserve`, vs Postgres real. Prueba el ciclo money-clawed-back con
 * balances exactos: al abrir se aparta del disponible; `won` lo devuelve
 * íntegro, `lost` lo forfeita al proveedor. Cada test usa un TENANT nuevo
 * (aislamiento total de balances, incl. platform-scope como provider.clearing).
 */

let ctx: TestContext;
let posting: PostingService;
let disputes: DisputeService;

const cop = (n: number) => Money.of(n, 'COP');

async function scenario(): Promise<{ org: string; m: string }> {
  const org = await ctx.createTenant(`Dispute ${randomUUID().slice(0, 8)}`);
  const res = await ctx.admin.query<{ id: string }>(
    `INSERT INTO merchants (tenant_id, name) VALUES ($1, $2) RETURNING id`,
    [org, `dp-shop-${randomUUID().slice(0, 8)}`]
  );
  return { org, m: res.rows[0]!.id };
}

/**
 * Siembra el disponible del comercio con dinero real: captura (provider.clearing
 * + merchant.pending) -> liberación a disponible. Deja `merchant.available = X` Y
 * `provider.clearing = X` (una disputa perdida forfeita a clearing, como un
 * refund; sin clearing no habría de dónde devolver). Sin fee.
 */
async function seedAvailable(org: string, m: string, amount: number): Promise<void> {
  const src = randomUUID();
  await posting.capturePayment({
    tenantId: org,
    merchantId: m,
    idempotencyKey: `cap:${src}`,
    sourceType: 'payment_attempt',
    sourceId: src,
    amount: cop(amount),
  });
  await posting.releaseSettlement({
    tenantId: org,
    merchantId: m,
    idempotencyKey: `settle:${src}`,
    sourceType: 'settlement',
    sourceId: src,
    amount: cop(amount),
  });
}

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
const reserve = (org: string, m: string) => bal(org, `dispute.reserve:${m}`);

async function disputeRow(id: string) {
  const res = await ctx.admin.query<{ status: string; resolved_at: Date | null }>(
    `SELECT status, resolved_at FROM disputes WHERE id = $1`,
    [id]
  );
  return res.rows[0]!;
}

async function ledgerTxCount(disputeId: string): Promise<number> {
  const res = await ctx.admin.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM ledger_transactions
     WHERE source_type = 'dispute' AND source_id = $1`,
    [disputeId]
  );
  return Number(res.rows[0]!.n);
}

beforeAll(async () => {
  ctx = await createTestContext();
  posting = new PostingService(new LedgerService(ctx.app), ctx.app);
  disputes = new DisputeService(ctx.app, posting);
}, 30_000);

afterAll(async () => {
  await ctx.close();
});

describe('DisputeService — ciclo money-clawed-back (F4-08a)', () => {
  it('open aparta del disponible a dispute.reserve; won lo devuelve íntegro', async () => {
    const { org, m } = await scenario();
    await seedAvailable(org, m, 100_000);

    const d = await disputes.open(org, {
      merchantId: m,
      amount: 30_000n,
      currency: 'COP',
      reason: 'fraudulent',
    });
    expect(d.status).toBe('open');
    expect(d.amount).toBe('30000');
    // Apartado: el disponible bajó y la reserva de disputa subió.
    expect(await available(org, m)).toBe(70_000n);
    expect(await reserve(org, m)).toBe(30_000n);

    const outcome = await disputes.resolve(org, {
      disputeId: d.id,
      outcome: 'won',
      providerRef: 'dp_won_1',
    });
    expect(outcome).toBe('applied');
    const row = await disputeRow(d.id);
    expect(row.status).toBe('won');
    expect(row.resolved_at).not.toBeNull();
    // Ganada: lo apartado vuelve íntegro; clearing intacto (el dinero no salió).
    expect(await available(org, m)).toBe(100_000n);
    expect(await reserve(org, m)).toBe(0n);
    expect(await bal(org, 'provider.clearing')).toBe(100_000n);
    // open + win = 2 asientos.
    expect(await ledgerTxCount(d.id)).toBe(2);
  });

  it('lost forfeita lo apartado al proveedor (el dinero se va)', async () => {
    const { org, m } = await scenario();
    await seedAvailable(org, m, 100_000);

    const d = await disputes.open(org, { merchantId: m, amount: 30_000n, currency: 'COP' });
    const outcome = await disputes.resolve(org, {
      disputeId: d.id,
      outcome: 'lost',
      providerRef: 'dp_lost_1',
    });
    expect(outcome).toBe('applied');
    expect((await disputeRow(d.id)).status).toBe('lost');

    // Perdida: la reserva se descarga contra clearing (el dinero se fue de
    // vuelta vía el proveedor). El disponible NO se recupera.
    expect(await available(org, m)).toBe(70_000n);
    expect(await reserve(org, m)).toBe(0n);
    expect(await bal(org, 'provider.clearing')).toBe(70_000n);
    expect(await ledgerTxCount(d.id)).toBe(2);
  });

  it('open -> under_review -> lost (fase de evidencia, sin mover dinero)', async () => {
    const { org, m } = await scenario();
    await seedAvailable(org, m, 100_000);

    const d = await disputes.open(org, { merchantId: m, amount: 40_000n, currency: 'COP' });
    const reviewed = await disputes.submitEvidence(org, d.id);
    expect(reviewed.status).toBe('under_review');
    // submitEvidence no movió dinero: sigue apartado.
    expect(await available(org, m)).toBe(60_000n);
    expect(await reserve(org, m)).toBe(40_000n);

    await disputes.resolve(org, { disputeId: d.id, outcome: 'lost' });
    expect((await disputeRow(d.id)).status).toBe('lost');
    expect(await bal(org, 'provider.clearing')).toBe(60_000n);
    // under_review no postea asiento: solo open + lose.
    expect(await ledgerTxCount(d.id)).toBe(2);
  });

  it('no double-spend: disputas abiertas no pueden exceder el disponible en conjunto', async () => {
    const { org, m } = await scenario();
    await seedAvailable(org, m, 100_000);

    await disputes.open(org, { merchantId: m, amount: 60_000n, currency: 'COP' });
    await disputes.open(org, { merchantId: m, amount: 40_000n, currency: 'COP' });
    // El disponible ya está apartado por ambas: una tercera no cabe.
    expect(await available(org, m)).toBe(0n);
    await expect(
      disputes.open(org, { merchantId: m, amount: 1n, currency: 'COP' })
    ).rejects.toBeInstanceOf(InsufficientDisputeBalanceError);
  });

  it('abrir por encima del disponible se rechaza sin crear la disputa', async () => {
    const { org, m } = await scenario();
    await seedAvailable(org, m, 20_000);
    await expect(
      disputes.open(org, { merchantId: m, amount: 20_001n, currency: 'COP' })
    ).rejects.toBeInstanceOf(InsufficientDisputeBalanceError);
    // Nada se movió ni se creó.
    expect(await available(org, m)).toBe(20_000n);
    const n = await ctx.admin.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM disputes WHERE merchant_id = $1`,
      [m]
    );
    expect(Number(n.rows[0]!.n)).toBe(0);
  });

  it('resolución idempotente/fuera de orden y disputa inexistente', async () => {
    const { org, m } = await scenario();
    await seedAvailable(org, m, 50_000);
    const d = await disputes.open(org, { merchantId: m, amount: 50_000n, currency: 'COP' });
    await disputes.resolve(org, { disputeId: d.id, outcome: 'won' });

    // Re-resolver una disputa ya terminal es un evento fuera de orden (no dobla).
    expect(await disputes.resolve(org, { disputeId: d.id, outcome: 'lost' })).toBe(
      'ignored_out_of_order'
    );
    expect((await disputeRow(d.id)).status).toBe('won');
    expect(await ledgerTxCount(d.id)).toBe(2);
    expect(await available(org, m)).toBe(50_000n);

    // Una disputa inexistente para este tenant no rompe nada.
    expect(await disputes.resolve(org, { disputeId: randomUUID(), outcome: 'won' })).toBe(
      'ignored'
    );
    // get de una disputa inexistente.
    await expect(disputes.get(org, randomUUID())).rejects.toBeInstanceOf(DisputeNotFoundError);
  });

  it('openFromProvider es idempotente por provider_ref (jamás doble-abre — F4-08c)', async () => {
    const { org, m } = await scenario();
    await seedAvailable(org, m, 100_000);
    const ref = `dp_${randomUUID().slice(0, 8)}`;
    const first = await disputes.openFromProvider(org, {
      merchantId: m,
      amount: 30_000n,
      currency: 'COP',
      providerRef: ref,
    });
    expect(first.created).toBe(true);
    expect(await reserve(org, m)).toBe(30_000n);

    // Reproceso del mismo provider_ref (crash-retry del inbox): no doble-abre.
    const second = await disputes.openFromProvider(org, {
      merchantId: m,
      amount: 30_000n,
      currency: 'COP',
      providerRef: ref,
    });
    expect(second.created).toBe(false);
    expect(second.dispute.id).toBe(first.dispute.id);
    // Un solo hold: la reserva sigue en 30k, no 60k.
    expect(await reserve(org, m)).toBe(30_000n);
    expect(await available(org, m)).toBe(70_000n);
  });
});
