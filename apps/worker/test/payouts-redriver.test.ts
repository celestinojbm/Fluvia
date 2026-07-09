import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@fluvia/config';
import { createPool, type Pool } from '@fluvia/db';
import { LedgerService, PostingService } from '@fluvia/ledger';
import { Money } from '@fluvia/money';
import { MockPaymentProvider, PayoutService } from '@fluvia/payments-core';
import { PayoutsRedriver } from '../src/payouts-redriver.js';

/**
 * F4-07e — claim_stuck_payouts() (0035) + PayoutsRedriver contra PG real. Un
 * payout que se queda en `requested` mas alla del lease significa que su
 * `execute` nunca corrio (el banco JAMAS fue contactado): re-conducirlo es
 * seguro. El claim toma un LEASE (updated_at) bajo FOR UPDATE SKIP LOCKED, de
 * modo que dos workers jamas conduzcan el mismo payout a la vez. Los conteos
 * globales se comprueban con `>=` (el claim es cross-tenant); el desenlace se
 * asserta por FILA. Cada caso usa un TENANT nuevo: las cuentas platform-scope
 * (payout.in_transit, platform.cash) son por tenant y no deben cruzarse, y el
 * pre-chequeo de fundabilidad cuenta los `requested` en vuelo del comercio.
 */

let workerPool: Pool;
let appPool: Pool;
let relayPool: Pool;
let adminPool: Pool;
let posting: PostingService;
let payouts: PayoutService;
let redriver: PayoutsRedriver;

const cop = (n: number) => Money.of(n, 'COP');

/** Tenant + comercio nuevos: aislamiento total de balances (incl. platform). */
async function scenario(): Promise<{ org: string; m: string }> {
  const org = (
    await adminPool.query<{ id: string }>(
      `INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id`,
      [`Payout RD ${randomUUID().slice(0, 8)}`, `prd-${randomUUID()}`]
    )
  ).rows[0]!.id;
  const m = (
    await adminPool.query<{ id: string }>(
      `INSERT INTO merchants (tenant_id, name) VALUES ($1, $2) RETURNING id`,
      [org, `prd-shop-${randomUUID().slice(0, 8)}`]
    )
  ).rows[0]!.id;
  return { org, m };
}

/** Inserta un payout `requested` directamente (el claim no depende del balance). */
async function insertRequested(org: string, m: string): Promise<string> {
  const res = await adminPool.query<{ id: string }>(
    `INSERT INTO payouts (tenant_id, merchant_id, amount, currency, provider)
     VALUES ($1, $2, 50000, 'COP', 'mock') RETURNING id`,
    [org, m]
  );
  return res.rows[0]!.id;
}

/** Envejece created_at Y updated_at (atascado + lease libre); no toca status. */
async function age(id: string, minutes: number): Promise<void> {
  await adminPool.query(
    `UPDATE payouts SET created_at = now() - make_interval(mins => $2),
                        updated_at = now() - make_interval(mins => $2)
     WHERE id = $1`,
    [id, minutes]
  );
}

/**
 * Siembra el estado money-IN completo (como en payouts.test): captura -> el
 * proveedor liquida a la caja de Fluvia -> liberacion a disponible. Deja
 * `merchant.available = X` Y `platform.cash = X` (sin caja no hay con que pagar).
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
  await posting.receiveProviderSettlement({
    tenantId: org,
    merchantId: m,
    idempotencyKey: `prov:${src}`,
    sourceType: 'settlement',
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
  const res = await adminPool.query<{ available: string }>(
    `SELECT COALESCE(bp.available, 0)::text AS available
     FROM ledger_accounts la
     JOIN balance_projections bp ON bp.account_id = la.id
     WHERE la.tenant_id = $1 AND la.name = $2 AND la.currency = 'COP'`,
    [org, name]
  );
  return BigInt(res.rows[0]?.available ?? '0');
}

async function statusOf(id: string): Promise<string> {
  const res = await adminPool.query<{ status: string }>(
    `SELECT status FROM payouts WHERE id = $1`,
    [id]
  );
  return res.rows[0]!.status;
}

beforeAll(async () => {
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' });
  workerPool = createPool({ connectionString: config.db.worker, max: 2 });
  appPool = createPool({ connectionString: config.db.app, max: 2 });
  relayPool = createPool({ connectionString: config.db.relay, max: 2 });
  adminPool = createPool({ connectionString: config.db.admin, max: 2 });
  posting = new PostingService(new LedgerService(appPool), appPool);
  payouts = new PayoutService(appPool, posting, new MockPaymentProvider());
  redriver = new PayoutsRedriver(workerPool, payouts);
}, 30_000);

afterAll(async () => {
  await Promise.all([workerPool.end(), appPool.end(), relayPool.end(), adminPool.end()]);
});

describe('claim_stuck_payouts() — claim con lease (0035)', () => {
  it('claims ONLY past-lease requested payouts, takes the lease, audits atomically', async () => {
    const { org, m } = await scenario();
    const stale = await insertRequested(org, m);
    await age(stale, 10);
    const fresh = await insertRequested(org, m); // updated_at ~now: dentro del lease

    const first = await workerPool.query<{ id: string; tenant_id: string }>(
      `SELECT id, tenant_id FROM claim_stuck_payouts(20)`
    );
    const firstIds = first.rows.map((r) => r.id);
    expect(firstIds).toContain(stale);
    expect(firstIds).not.toContain(fresh);
    // El claim devuelve el tenant para conducir el execute bajo RLS.
    expect(first.rows.find((r) => r.id === stale)!.tenant_id).toBe(org);

    // El claim NO cambia el estado (solo toma el lease): sigue `requested`.
    expect(await statusOf(stale)).toBe('requested');

    // Segundo claim inmediato: el lease (updated_at recien tocado) lo excluye.
    const second = await workerPool.query<{ id: string }>(`SELECT id FROM claim_stuck_payouts(20)`);
    expect(second.rows.map((r) => r.id)).not.toContain(stale);

    // Auditoria atomica del claim con el id reclamado.
    const audit = await adminPool.query<{ after_summary: { payout_ids: string[] } }>(
      `SELECT after_summary FROM audit_events
       WHERE action = 'payout.redrive_claimed'
       ORDER BY id DESC LIMIT 5`
    );
    expect(audit.rows.some((r) => r.after_summary.payout_ids.includes(stale))).toBe(true);
  });

  it('only the worker role may execute the claim', async () => {
    await expect(appPool.query(`SELECT * FROM claim_stuck_payouts(20)`)).rejects.toThrow(
      /permission denied/i
    );
    await expect(relayPool.query(`SELECT * FROM claim_stuck_payouts(20)`)).rejects.toThrow(
      /permission denied/i
    );
  });
});

describe('PayoutsRedriver (F4-07e)', () => {
  it('re-drives a stuck requested payout to paid (execute never ran; bank never contacted)', async () => {
    const { org, m } = await scenario();
    await seedAvailable(org, m, 100_000);
    expect(await bal(org, 'platform.cash')).toBe(100_000n);
    const po = await payouts.create(org, { merchantId: m, amount: 100_000n, currency: 'COP' });
    expect(po.status).toBe('requested');
    await age(po.id, 10);

    const result = await redriver.runOnce();
    expect(result.claimed).toBeGreaterThanOrEqual(1);
    expect(result.redriven).toBeGreaterThanOrEqual(1);

    // El payout quedo `paid`: el disponible salio del comercio y la caja se
    // descargo al pagar al banco (100k recibidos, 100k pagados ⇒ caja neta 0).
    expect(await statusOf(po.id)).toBe('paid');
    expect(await bal(org, `merchant.available:${m}`)).toBe(0n);
    expect(await bal(org, 'payout.in_transit')).toBe(0n);
    expect(await bal(org, 'platform.cash')).toBe(0n);
  });

  it('is idempotent: a second run neither re-claims nor double-pays the paid payout', async () => {
    const { org, m } = await scenario();
    await seedAvailable(org, m, 25_000);
    const po = await payouts.create(org, { merchantId: m, amount: 25_000n, currency: 'COP' });
    await age(po.id, 10);
    await redriver.runOnce();
    expect(await statusOf(po.id)).toBe('paid');

    // Ya no es `requested`: el segundo claim no lo devuelve.
    await redriver.runOnce();
    const claim = await workerPool.query<{ id: string }>(`SELECT id FROM claim_stuck_payouts(20)`);
    expect(claim.rows.map((r) => r.id)).not.toContain(po.id);
    expect(await statusOf(po.id)).toBe('paid');
    // Los asientos son emit + settle, sin duplicar.
    const txs = await adminPool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM ledger_transactions
       WHERE source_type = 'payout' AND source_id = $1`,
      [po.id]
    );
    expect(Number(txs.rows[0]!.n)).toBe(2);
  });

  it('onResult observer fires and its failure never breaks the job', async () => {
    const rd = new PayoutsRedriver(
      workerPool,
      payouts,
      { info: () => undefined, error: () => undefined },
      {
        onResult: () => {
          throw new Error('observer exploded');
        },
      }
    );
    await expect(rd.runOnce()).resolves.toBeDefined();
  });
});
