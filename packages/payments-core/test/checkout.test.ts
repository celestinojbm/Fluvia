import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenantTransaction } from '@fluvia/db';
import { createTestContext, type TestContext } from '@fluvia/db/testing';
import { Money } from '@fluvia/money';
import { LedgerService, PostingService } from '@fluvia/ledger';
import {
  CheckoutSessionInvalidCustomerError,
  CheckoutSessionNotFoundError,
  CheckoutSessionService,
  InvalidStateTransitionError,
  MockPaymentProvider,
  PaymentConfirmationService,
  PaymentIntentNotFoundError,
  PaymentIntentService,
  ZERO_FEE_SCHEDULE,
  hashClientSecret,
} from '../src/index.js';

/** Camino legal de la FSM del intent hasta succeeded (sin tocar el ledger). */
async function driveIntentToSucceeded(
  intents: PaymentIntentService,
  org: string,
  intentId: string
) {
  for (const to of [
    'requires_payment_method',
    'requires_confirmation',
    'processing',
    'succeeded',
  ] as const) {
    await intents.transition(org, intentId, to);
  }
}

/**
 * F3-05b — CheckoutSessionService contra PG real: creación sobre un intent
 * abierto, guard de intent resuelto, client_secret (hash en reposo) entregado
 * una vez, customer opcional validado y aislamiento por tenant.
 */

let ctx: TestContext;
let intents: PaymentIntentService;
let service: CheckoutSessionService;
let serviceWithConfirm: CheckoutSessionService;
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
  const posting = new PostingService(new LedgerService(ctx.app), ctx.app);
  serviceWithConfirm = new CheckoutSessionService(ctx.app, {
    confirmation: new PaymentConfirmationService(
      ctx.app,
      intents,
      posting,
      new MockPaymentProvider(),
      ZERO_FEE_SCHEDULE
    ),
  });
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

async function checkoutTopics(sessionId: string): Promise<string[]> {
  const res = await ctx.admin.query<{ topic: string }>(
    `SELECT topic FROM outbox_events
     WHERE payload->'data'->>'checkout_session_id' = $1 ORDER BY id`,
    [sessionId]
  );
  return res.rows.map((r) => r.topic);
}

describe('plano alojado (getByClientSecret, F3-05c)', () => {
  it('returns a REDACTED view for a valid client_secret; a wrong secret is not found', async () => {
    const intentId = await newIntent();
    const s = await createSession(org, { paymentIntentId: intentId });
    const view = await service.getByClientSecret(s.id, s.clientSecret);
    expect(view.id).toBe(s.id);
    expect(view.status).toBe('open');
    expect(view.paymentIntent).toEqual({
      id: intentId,
      status: 'created',
      amount: '50000',
      currency: 'COP',
    });
    // Sin secretos ni internos del comercio.
    expect(view).not.toHaveProperty('clientSecret');
    expect(JSON.stringify(view)).not.toContain('tenant');

    await expect(service.getByClientSecret(s.id, 'cs_wrong')).rejects.toThrow(
      CheckoutSessionNotFoundError
    );
    // Secreto correcto pero id equivocado: tampoco.
    await expect(service.getByClientSecret(randomUUID(), s.clientSecret)).rejects.toThrow(
      CheckoutSessionNotFoundError
    );
  });

  it('completes when the intent succeeds and emits checkout_session.completed ONCE', async () => {
    const intentId = await newIntent();
    const s = await createSession(org, { paymentIntentId: intentId });
    await driveIntentToSucceeded(intents, org, intentId);

    const view = await service.getByClientSecret(s.id, s.clientSecret);
    expect(view.status).toBe('completed');
    expect(view.paymentIntent.status).toBe('succeeded');
    expect(await checkoutTopics(s.id)).toEqual(['checkout_session.completed']);

    // Segunda consulta: sigue completed, sin re-emitir.
    const again = await service.getByClientSecret(s.id, s.clientSecret);
    expect(again.status).toBe('completed');
    expect(await checkoutTopics(s.id)).toEqual(['checkout_session.completed']);

    // completed_at quedó sellado.
    const row = await ctx.admin.query<{ completed_at: Date | null }>(
      `SELECT completed_at FROM checkout_sessions WHERE id = $1`,
      [s.id]
    );
    expect(row.rows[0]!.completed_at).not.toBeNull();
  });

  it('expires an open session past its TTL and emits checkout_session.expired ONCE', async () => {
    // TTL mínimo del servicio es 5 min; se siembra una sesión ya vencida vía
    // admin con un client_secret conocido para ejercitar la expiración.
    const intentId = await newIntent();
    const secret = `cs_${randomUUID()}`;
    const seeded = await ctx.admin.query<{ id: string }>(
      `INSERT INTO checkout_sessions
         (tenant_id, payment_intent_id, client_secret_hash, expires_at)
       VALUES ($1, $2, $3, now() - interval '1 minute') RETURNING id`,
      [org, intentId, hashClientSecret(secret)]
    );
    const id = seeded.rows[0]!.id;

    const view = await service.getByClientSecret(id, secret);
    expect(view.status).toBe('expired');
    expect(await checkoutTopics(id)).toEqual(['checkout_session.expired']);

    // Idempotente: segunda consulta no re-emite.
    await service.getByClientSecret(id, secret);
    expect(await checkoutTopics(id)).toEqual(['checkout_session.expired']);
  });

  it('a succeeded intent wins over an expired TTL (completed, not expired)', async () => {
    const intentId = await newIntent();
    await driveIntentToSucceeded(intents, org, intentId);
    const secret = `cs_${randomUUID()}`;
    const seeded = await ctx.admin.query<{ id: string }>(
      `INSERT INTO checkout_sessions
         (tenant_id, payment_intent_id, client_secret_hash, expires_at)
       VALUES ($1, $2, $3, now() - interval '1 minute') RETURNING id`,
      [org, intentId, hashClientSecret(secret)]
    );
    const view = await service.getByClientSecret(seeded.rows[0]!.id, secret);
    expect(view.status).toBe('completed');
    expect(await checkoutTopics(seeded.rows[0]!.id)).toEqual(['checkout_session.completed']);
  });
});

describe('confirm alojado (confirmByClientSecret, F3-05c-iii)', () => {
  async function attemptCount(intentId: string): Promise<number> {
    const r = await ctx.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM payment_attempts WHERE intent_id = $1`,
      [intentId]
    );
    return Number(r.rows[0]!.n);
  }

  it('tok_approve confirms the intent, completes the session and emits the event', async () => {
    const intentId = await newIntent();
    const s = await createSession(org, { paymentIntentId: intentId });
    const view = await serviceWithConfirm.confirmByClientSecret(
      s.id,
      s.clientSecret,
      'tok_approve'
    );
    expect(view.status).toBe('completed');
    expect(view.paymentIntent.status).toBe('succeeded');
    expect(await checkoutTopics(s.id)).toEqual(['checkout_session.completed']);
    expect(await attemptCount(intentId)).toBe(1);
  });

  it('tok_decline fails the intent; the session stays open reflecting the failure', async () => {
    const intentId = await newIntent();
    const s = await createSession(org, { paymentIntentId: intentId });
    const view = await serviceWithConfirm.confirmByClientSecret(
      s.id,
      s.clientSecret,
      'tok_decline'
    );
    expect(view.paymentIntent.status).toBe('failed');
    // El intent falló (terminal); la sesión no completa — expirará por TTL.
    expect(view.status).toBe('open');
    expect(await checkoutTopics(s.id)).toEqual([]);
  });

  it('double submit is idempotent: no second attempt, returns the current view', async () => {
    const intentId = await newIntent();
    const s = await createSession(org, { paymentIntentId: intentId });
    await serviceWithConfirm.confirmByClientSecret(s.id, s.clientSecret, 'tok_approve');
    const again = await serviceWithConfirm.confirmByClientSecret(
      s.id,
      s.clientSecret,
      'tok_approve'
    );
    expect(again.status).toBe('completed');
    expect(await attemptCount(intentId)).toBe(1); // jamás un segundo attempt
  });

  it('a wrong client_secret is not found; without a confirmation service it throws', async () => {
    const intentId = await newIntent();
    const s = await createSession(org, { paymentIntentId: intentId });
    await expect(
      serviceWithConfirm.confirmByClientSecret(s.id, 'cs_wrong', 'tok_approve')
    ).rejects.toThrow(CheckoutSessionNotFoundError);
    // `service` se construyó SIN confirmation: el confirm alojado no aplica.
    await expect(
      service.confirmByClientSecret(s.id, s.clientSecret, 'tok_approve')
    ).rejects.toThrow(/without a confirmation service/);
  });
});
