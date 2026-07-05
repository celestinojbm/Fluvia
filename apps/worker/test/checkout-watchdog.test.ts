import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@fluvia/config';
import { createPool, type Pool } from '@fluvia/db';
import { EventEnvelopeSchema } from '@fluvia/events';
import { PaymentIntentService } from '@fluvia/payments-core';
import { Money } from '@fluvia/money';
import { CheckoutSessionWatchdog } from '../src/checkout-watchdog.js';

/**
 * F3-05c-ii — el barrido de entrega garantizada: completa/expira sesiones que
 * NADIE consultó y emite `checkout_session.*` al outbox. Verifica además que el
 * sobre construido EN SQL valida contra el mismo schema que exige el relay
 * (un sobre malformado sería veneno).
 */

let workerPool: Pool;
let appPool: Pool;
let adminPool: Pool;
let intents: PaymentIntentService;
let org: string;
let merchantId: string;

const cop = (u: number) => Money.of(u, 'COP');

async function newIntent(): Promise<string> {
  const i = await intents.create({ tenantId: org, merchantId, amount: cop(50_000) });
  return i.id;
}

async function driveToSucceeded(intentId: string) {
  for (const to of [
    'requires_payment_method',
    'requires_confirmation',
    'processing',
    'succeeded',
  ] as const) {
    await intents.transition(org, intentId, to);
  }
}

async function seedSession(intentId: string, expiresSql: string): Promise<string> {
  const res = await adminPool.query<{ id: string }>(
    `INSERT INTO checkout_sessions (tenant_id, payment_intent_id, client_secret_hash, expires_at)
     VALUES ($1, $2, $3, ${expiresSql}) RETURNING id`,
    [org, intentId, 'seedhash']
  );
  return res.rows[0]!.id;
}

async function sessionStatus(id: string): Promise<string> {
  const r = await adminPool.query<{ status: string }>(
    `SELECT status FROM checkout_sessions WHERE id = $1`,
    [id]
  );
  return r.rows[0]!.status;
}

async function eventFor(id: string): Promise<{ topic: string; payload: unknown } | undefined> {
  const r = await adminPool.query<{ topic: string; payload: unknown }>(
    `SELECT topic, payload FROM outbox_events
     WHERE payload->'data'->>'checkout_session_id' = $1 ORDER BY id DESC LIMIT 1`,
    [id]
  );
  return r.rows[0];
}

beforeAll(async () => {
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' });
  workerPool = createPool({ connectionString: config.db.worker, max: 2 });
  appPool = createPool({ connectionString: config.db.app, max: 4 });
  adminPool = createPool({ connectionString: config.db.admin, max: 2 });
  intents = new PaymentIntentService(appPool);
  org = await adminPool
    .query<{ id: string }>(`INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id`, [
      `CW ${randomUUID().slice(0, 8)}`,
      `cw-${randomUUID()}`,
    ])
    .then((r) => r.rows[0]!.id);
  merchantId = await adminPool
    .query<{ id: string }>(`INSERT INTO merchants (tenant_id, name) VALUES ($1, $2) RETURNING id`, [
      org,
      `cw-shop-${randomUUID().slice(0, 8)}`,
    ])
    .then((r) => r.rows[0]!.id);
}, 30_000);

afterAll(async () => {
  await Promise.all([workerPool.end(), appPool.end(), adminPool.end()]);
});

describe('CheckoutSessionWatchdog (F3-05c-ii)', () => {
  it('runOnce returns integer completed/expired counts', async () => {
    const wd = new CheckoutSessionWatchdog(workerPool);
    const r = await wd.runOnce();
    expect(Number.isInteger(r.completed)).toBe(true);
    expect(Number.isInteger(r.expired)).toBe(true);
    expect(r.completed).toBeGreaterThanOrEqual(0);
    expect(r.expired).toBeGreaterThanOrEqual(0);
  });

  it('completes an un-polled session whose intent succeeded and emits a VALID envelope', async () => {
    const intentId = await newIntent();
    const sessionId = await seedSession(intentId, `now() + interval '1 hour'`);
    await driveToSucceeded(intentId);

    await new CheckoutSessionWatchdog(workerPool).runOnce();

    expect(await sessionStatus(sessionId)).toBe('completed');
    const ev = await eventFor(sessionId);
    expect(ev?.topic).toBe('checkout_session.completed');
    // El sobre construido en SQL debe pasar el MISMO schema que valida el relay.
    const parsed = EventEnvelopeSchema.safeParse(ev?.payload);
    expect(parsed.success, JSON.stringify(parsed)).toBe(true);
    expect((ev?.payload as { data: { status: string } }).data.status).toBe('completed');
  });

  it('expires an un-polled session past its TTL and emits a VALID envelope', async () => {
    const intentId = await newIntent();
    const sessionId = await seedSession(intentId, `now() - interval '1 minute'`);

    await new CheckoutSessionWatchdog(workerPool).runOnce();

    expect(await sessionStatus(sessionId)).toBe('expired');
    const ev = await eventFor(sessionId);
    expect(ev?.topic).toBe('checkout_session.expired');
    expect(EventEnvelopeSchema.safeParse(ev?.payload).success).toBe(true);
  });

  it('is idempotent with the lazy sync: a completed session is not re-swept', async () => {
    const intentId = await newIntent();
    const sessionId = await seedSession(intentId, `now() + interval '1 hour'`);
    await driveToSucceeded(intentId);
    await new CheckoutSessionWatchdog(workerPool).runOnce();
    // Segundo barrido: la sesión ya no está `open`, no re-emite.
    await new CheckoutSessionWatchdog(workerPool).runOnce();
    const events = await adminPool.query(
      `SELECT 1 FROM outbox_events WHERE payload->'data'->>'checkout_session_id' = $1`,
      [sessionId]
    );
    expect(events.rowCount).toBe(1);
  });

  it('a succeeded intent wins over an expired TTL in the sweep too', async () => {
    const intentId = await newIntent();
    await driveToSucceeded(intentId);
    const sessionId = await seedSession(intentId, `now() - interval '1 minute'`);
    await new CheckoutSessionWatchdog(workerPool).runOnce();
    expect(await sessionStatus(sessionId)).toBe('completed');
    expect((await eventFor(sessionId))?.topic).toBe('checkout_session.completed');
  });

  it('onResult observer fires and its failure never breaks the job', async () => {
    const wd = new CheckoutSessionWatchdog(
      workerPool,
      { info: () => undefined, error: () => undefined },
      {
        onResult: () => {
          throw new Error('observer exploded');
        },
      }
    );
    await expect(wd.runOnce()).resolves.toBeDefined();
  });
});
