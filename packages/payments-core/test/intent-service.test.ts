import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenantTransaction } from '@fluvia/db';
import { createTestContext, type TestContext } from '@fluvia/db/testing';
import { Money } from '@fluvia/money';
import {
  InvalidStateTransitionError,
  PaymentIntentNotFoundError,
  PaymentIntentService,
} from '../src/index.js';

let ctx: TestContext;
let service: PaymentIntentService;
let orgA: string;
let orgB: string;
let merchantA: string;
let merchantB: string;

async function seedMerchant(tenantId: string): Promise<string> {
  const res = await ctx.admin.query<{ id: string }>(
    `INSERT INTO merchants (tenant_id, name) VALUES ($1, $2) RETURNING id`,
    [tenantId, `intent-shop-${randomUUID().slice(0, 8)}`]
  );
  return res.rows[0]!.id;
}

beforeAll(async () => {
  ctx = await createTestContext();
  service = new PaymentIntentService(ctx.app);
  orgA = await ctx.createTenant(`Intents A ${randomUUID().slice(0, 8)}`);
  orgB = await ctx.createTenant(`Intents B ${randomUUID().slice(0, 8)}`);
  merchantA = await seedMerchant(orgA);
  merchantB = await seedMerchant(orgB);
}, 30_000);

afterAll(async () => {
  await ctx.close();
});

const cop = (units: number) => Money.of(units, 'COP');

describe('PaymentIntentService (F3-01 — plano interno, sin endpoints)', () => {
  it('creates an intent in `created`, emits the outbox event in the SAME transaction', async () => {
    const intent = await service.create({
      tenantId: orgA,
      merchantId: merchantA,
      amount: cop(250_000),
      description: 'pedido demo',
    });
    expect(intent.status).toBe('created');
    expect(intent.amount).toBe('250000');
    expect(intent.currency).toBe('COP');

    const events = await ctx.admin.query<{ topic: string; payload: { data: { status: string } } }>(
      `SELECT topic, payload FROM outbox_events
       WHERE tenant_id = $1 AND topic = 'payment_intent.created'
         AND payload->'data'->>'payment_intent_id' = $2`,
      [orgA, intent.id]
    );
    expect(events.rowCount).toBe(1);
  });

  it('walks the happy path with version bumps and terminal timestamps', async () => {
    const intent = await service.create({
      tenantId: orgA,
      merchantId: merchantA,
      amount: cop(90_000),
    });
    const chain = [
      'requires_payment_method',
      'requires_confirmation',
      'processing',
      'succeeded',
    ] as const;
    let version = BigInt(intent.version);
    for (const to of chain) {
      const updated = await service.transition(orgA, intent.id, to);
      expect(updated.status).toBe(to);
      expect(BigInt(updated.version)).toBe(version + 1n);
      version = BigInt(updated.version);
    }
    const row = await ctx.admin.query<{ succeeded_at: Date | null }>(
      `SELECT succeeded_at FROM payment_intents WHERE id = $1`,
      [intent.id]
    );
    expect(row.rows[0]!.succeeded_at).not.toBeNull();
    // Un evento por estado recorrido, todos en el outbox.
    const topics = await ctx.admin.query<{ topic: string }>(
      `SELECT topic FROM outbox_events
       WHERE tenant_id = $1 AND payload->'data'->>'payment_intent_id' = $2
       ORDER BY id`,
      [orgA, intent.id]
    );
    expect(topics.rows.map((r) => r.topic)).toEqual([
      'payment_intent.created',
      ...chain.map((s) => `payment_intent.${s}`),
    ]);
  });

  it('rejects illegal transitions at the SERVICE and leaves no trace', async () => {
    const intent = await service.create({
      tenantId: orgA,
      merchantId: merchantA,
      amount: cop(10_000),
    });
    await expect(service.transition(orgA, intent.id, 'succeeded')).rejects.toThrow(
      InvalidStateTransitionError
    );
    expect((await service.get(orgA, intent.id)).status).toBe('created');
  });

  it('rejects illegal transitions at the ENGINE even skipping the service (app role)', async () => {
    const intent = await service.create({
      tenantId: orgA,
      merchantId: merchantA,
      amount: cop(10_000),
    });
    await expect(
      withTenantTransaction(ctx.app, orgA, (c) =>
        c.query(`UPDATE payment_intents SET status = 'succeeded' WHERE id = $1`, [intent.id])
      )
    ).rejects.toThrow(/FLUVIA_INVALID_TRANSITION/);
  });

  it('failed requires and records a failure_code from the catalog', async () => {
    const intent = await service.create({
      tenantId: orgA,
      merchantId: merchantA,
      amount: cop(20_000),
    });
    await service.transition(orgA, intent.id, 'requires_payment_method');
    await service.transition(orgA, intent.id, 'requires_confirmation');
    await service.transition(orgA, intent.id, 'processing');
    const failed = await service.transition(orgA, intent.id, 'failed', {
      failureCode: 'card_declined',
    });
    expect(failed.failureCode).toBe('card_declined');
  });

  it('is tenant-isolated: a foreign intent is indistinguishable from a missing one', async () => {
    const intent = await service.create({
      tenantId: orgA,
      merchantId: merchantA,
      amount: cop(5_000),
    });
    await expect(service.get(orgB, intent.id)).rejects.toThrow(PaymentIntentNotFoundError);
    await expect(service.transition(orgB, intent.id, 'requires_payment_method')).rejects.toThrow(
      PaymentIntentNotFoundError
    );
  });

  it('ENGINE: an intent can never reference another tenant merchant (composite FK)', async () => {
    await expect(
      ctx.admin.query(
        `INSERT INTO payment_intents (tenant_id, merchant_id, amount, currency)
         VALUES ($1, $2, 1000, 'COP')`,
        [orgA, merchantB]
      )
    ).rejects.toThrow(/payment_intents_merchant_coherence_fk/);
  });

  it('ENGINE: captured/refunded amount invariants hold even for the superuser', async () => {
    const intent = await service.create({
      tenantId: orgA,
      merchantId: merchantA,
      amount: cop(1_000),
    });
    await expect(
      ctx.admin.query(`UPDATE payment_intents SET amount_captured = 2000 WHERE id = $1`, [
        intent.id,
      ])
    ).rejects.toThrow(/payment_intents_captured_le_amount/);
    await expect(
      ctx.admin.query(`UPDATE payment_intents SET amount_refunded = 500 WHERE id = $1`, [intent.id])
    ).rejects.toThrow(/payment_intents_refunded_le_captured/);
  });
});
