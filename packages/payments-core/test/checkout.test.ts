import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenantTransaction } from '@fluvia/db';
import { createTestContext, type TestContext } from '@fluvia/db/testing';
import { Money } from '@fluvia/money';
import {
  CheckoutSessionInvalidCustomerError,
  CheckoutSessionNotFoundError,
  CheckoutSessionService,
  InvalidStateTransitionError,
  PaymentIntentNotFoundError,
  PaymentIntentService,
  hashClientSecret,
} from '../src/index.js';

/**
 * F3-05b — CheckoutSessionService contra PG real: creación sobre un intent
 * abierto, guard de intent resuelto, client_secret (hash en reposo) entregado
 * una vez, customer opcional validado y aislamiento por tenant.
 */

let ctx: TestContext;
let intents: PaymentIntentService;
let service: CheckoutSessionService;
let org: string;
let orgB: string;
let merchantId: string;

const cop = (units: number) => Money.of(units, 'COP');

async function newIntent(): Promise<string> {
  const intent = await intents.create({ tenantId: org, merchantId, amount: cop(50_000) });
  return intent.id;
}

async function createSession(
  tenantId: string,
  input: Parameters<CheckoutSessionService['createIn']>[2]
) {
  return withTenantTransaction(ctx.app, tenantId, (c) => service.createIn(c, tenantId, input));
}

beforeAll(async () => {
  ctx = await createTestContext();
  intents = new PaymentIntentService(ctx.app);
  service = new CheckoutSessionService(ctx.app, { checkoutBaseUrl: 'https://pay.fluvia.test/' });
  org = await ctx.createTenant(`CO ${randomUUID().slice(0, 8)}`);
  orgB = await ctx.createTenant(`CO-B ${randomUUID().slice(0, 8)}`);
  const m = await ctx.admin.query<{ id: string }>(
    `INSERT INTO merchants (tenant_id, name) VALUES ($1, $2) RETURNING id`,
    [org, `co-shop-${randomUUID().slice(0, 8)}`]
  );
  merchantId = m.rows[0]!.id;
}, 30_000);

afterAll(async () => {
  await ctx.close();
});

describe('create', () => {
  it('opens a session over an open intent; client_secret is returned once and stored hashed', async () => {
    const intentId = await newIntent();
    const s = await createSession(org, { paymentIntentId: intentId });
    expect(s.status).toBe('open');
    expect(s.paymentIntentId).toBe(intentId);
    expect(s.clientSecret).toMatch(/^cs_[A-Za-z0-9_-]+$/);
    // La URL alojada usa el id y la base normalizada (sin doble slash).
    expect(s.url).toBe(`https://pay.fluvia.test/c/${s.id}`);
    // expires_at por defecto ~24 h en el futuro.
    expect(new Date(s.expiresAt).getTime()).toBeGreaterThan(Date.now() + 23 * 3600 * 1000);

    // La base guarda SOLO el hash del client_secret.
    const row = await ctx.admin.query<{ client_secret_hash: string }>(
      `SELECT client_secret_hash FROM checkout_sessions WHERE id = $1`,
      [s.id]
    );
    expect(row.rows[0]!.client_secret_hash).toBe(hashClientSecret(s.clientSecret));
    expect(row.rows[0]!.client_secret_hash).not.toContain(s.clientSecret);
  });

  it('clamps the TTL to [5 min, 24 h]', async () => {
    const short = await createSession(org, {
      paymentIntentId: await newIntent(),
      expiresInMinutes: 1,
    });
    expect(new Date(short.expiresAt).getTime()).toBeGreaterThan(Date.now() + 4 * 60 * 1000);
    const long = await createSession(org, {
      paymentIntentId: await newIntent(),
      expiresInMinutes: 100_000,
    });
    expect(new Date(long.expiresAt).getTime()).toBeLessThan(Date.now() + 25 * 3600 * 1000);
  });

  it('rejects a missing intent and an already-resolved intent', async () => {
    await expect(createSession(org, { paymentIntentId: randomUUID() })).rejects.toThrow(
      PaymentIntentNotFoundError
    );
    // Lleva un intent a canceled (terminal) y comprueba el guard de estado.
    const intentId = await newIntent();
    await intents.transition(org, intentId, 'canceled');
    await expect(createSession(org, { paymentIntentId: intentId })).rejects.toThrow(
      InvalidStateTransitionError
    );
  });

  it('accepts a valid customer and rejects a foreign/missing one', async () => {
    const intentId = await newIntent();
    const cust = await ctx.admin.query<{ id: string }>(
      `INSERT INTO customers (tenant_id, name) VALUES ($1, 'Buyer') RETURNING id`,
      [org]
    );
    const ok = await createSession(org, {
      paymentIntentId: intentId,
      customerId: cust.rows[0]!.id,
    });
    expect(ok.customerId).toBe(cust.rows[0]!.id);

    // Customer de otro tenant: invisible bajo RLS => inválido.
    const foreign = await ctx.admin.query<{ id: string }>(
      `INSERT INTO customers (tenant_id, name) VALUES ($1, 'Foreign') RETURNING id`,
      [orgB]
    );
    await expect(
      createSession(org, { paymentIntentId: await newIntent(), customerId: foreign.rows[0]!.id })
    ).rejects.toThrow(CheckoutSessionInvalidCustomerError);
  });

  it('cannot open a session over another tenant intent (RLS => not found)', async () => {
    const intentId = await newIntent();
    await expect(createSession(orgB, { paymentIntentId: intentId })).rejects.toThrow(
      PaymentIntentNotFoundError
    );
  });
});

describe('get + list', () => {
  it('get returns the session (no secret); foreign tenant is not found', async () => {
    const s = await createSession(org, { paymentIntentId: await newIntent() });
    const got = await service.get(org, s.id);
    expect(got.id).toBe(s.id);
    expect(got).not.toHaveProperty('clientSecret');
    await expect(service.get(orgB, s.id)).rejects.toThrow(CheckoutSessionNotFoundError);
  });

  it('list is tenant-scoped, newest-first', async () => {
    const isolated = await ctx.createTenant(`CO-L ${randomUUID().slice(0, 8)}`);
    const im = await ctx.admin.query<{ id: string }>(
      `INSERT INTO merchants (tenant_id, name) VALUES ($1, $2) RETURNING id`,
      [isolated, `co-l-${randomUUID().slice(0, 8)}`]
    );
    const mkIntent = async () => {
      const i = await new PaymentIntentService(ctx.app).create({
        tenantId: isolated,
        merchantId: im.rows[0]!.id,
        amount: cop(1000),
      });
      return i.id;
    };
    const s1 = await createSession(isolated, { paymentIntentId: await mkIntent() });
    const s2 = await createSession(isolated, { paymentIntentId: await mkIntent() });
    const list = await service.list(isolated, 100);
    expect(list.map((s) => s.id)).toEqual([s2.id, s1.id]);
    // Otro tenant no ve nada de estos.
    expect((await service.list(orgB, 100)).some((s) => s.id === s1.id)).toBe(false);
  });
});
