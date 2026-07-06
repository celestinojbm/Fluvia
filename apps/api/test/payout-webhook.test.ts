import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@fluvia/config';
import { createPool, type Pool } from '@fluvia/db';
import { AuthService } from '@fluvia/auth';
import { ApiKeyService, IdentityService } from '@fluvia/identity';
import { InboxProcessor, signWebhookPayload } from '@fluvia/inbox';
import { LedgerService, PostingService } from '@fluvia/ledger';
import { Money } from '@fluvia/money';
import {
  MOCK_PROVIDER_NAME,
  MockPaymentProvider,
  PaymentConfirmationService,
  PaymentIntentService,
  PayoutService,
  ProviderTimeoutError,
  ZERO_FEE_SCHEDULE,
  createMockInboxRegistration,
  type PaymentProvider,
} from '@fluvia/payments-core';
import { buildApp } from '../src/app.js';

/**
 * F4-07c-ii — el webhook FIRMADO del banco resuelve payouts `indeterminate`
 * (desenlace desconocido, fondos retenidos en tránsito) por fuente verificada,
 * sobre la MISMA cadena durable de F3-03b: ingesta firmada -> dedup -> schema ->
 * el handler del mock DESPACHA `payout.*` a PayoutService.resolveFromProvider.
 * Exactamente el cableado de producción (el worker usa este mismo registro).
 */

let app: FastifyInstance;
let appPool: Pool;
let authPool: Pool;
let adminPool: Pool;
let inboxPool: Pool;
let posting: PostingService;
let processor: InboxProcessor;
let timeoutPayouts: PayoutService;
let secret: string;
let org: string;
let merchant: string;

const cop = (n: number) => Money.of(n, 'COP');

function sign(rawBody: string) {
  const ts = Date.now();
  return {
    'x-fluvia-timestamp': String(ts),
    'x-fluvia-signature': signWebhookPayload(secret, ts, rawBody),
    'content-type': 'application/json',
  };
}

/** Deja `amount` en merchant.available Y en platform.cash (money-in completo). */
async function seedAvailable(amount: number): Promise<void> {
  const src = randomUUID();
  const m = cop(amount);
  await posting.capturePayment({
    tenantId: org,
    merchantId: merchant,
    idempotencyKey: `cap:${src}`,
    sourceType: 'payment_attempt',
    sourceId: src,
    amount: m,
  });
  await posting.receiveProviderSettlement({
    tenantId: org,
    merchantId: merchant,
    idempotencyKey: `prov:${src}`,
    sourceType: 'settlement',
    sourceId: src,
    amount: m,
  });
  await posting.releaseSettlement({
    tenantId: org,
    merchantId: merchant,
    idempotencyKey: `settle:${src}`,
    sourceType: 'settlement',
    sourceId: src,
    amount: m,
  });
}

/** Crea un payout y lo lleva a `indeterminate` (banco con timeout: fondos en tránsito). */
async function indeterminatePayout(amount: number): Promise<string> {
  await seedAvailable(amount);
  const po = await timeoutPayouts.create(org, {
    merchantId: merchant,
    amount: BigInt(amount),
    currency: 'COP',
  });
  await timeoutPayouts.execute(org, po.id);
  return po.id;
}

async function bal(name: string): Promise<bigint> {
  const res = await adminPool.query<{ available: string }>(
    `SELECT COALESCE(bp.available, 0)::text AS available
     FROM ledger_accounts la JOIN balance_projections bp ON bp.account_id = la.id
     WHERE la.tenant_id = $1 AND la.name = $2 AND la.currency = 'COP'`,
    [org, name]
  );
  return BigInt(res.rows[0]?.available ?? '0');
}

async function payoutStatus(id: string): Promise<string> {
  return (
    await adminPool.query<{ status: string }>(`SELECT status FROM payouts WHERE id = $1`, [id])
  ).rows[0]!.status;
}

beforeAll(async () => {
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' });
  secret = config.mockWebhookSecret;
  appPool = createPool({ connectionString: config.db.app, max: 6 });
  authPool = createPool({ connectionString: config.db.auth, max: 2 });
  adminPool = createPool({ connectionString: config.db.admin, max: 2 });
  inboxPool = createPool({ connectionString: config.db.inbox, max: 2 });

  app = buildApp({
    config,
    appPool,
    authService: new AuthService(authPool),
    identityService: new IdentityService(appPool),
    apiKeyService: new ApiKeyService(appPool),
  });
  await app.ready();

  posting = new PostingService(new LedgerService(appPool), appPool);
  const provider = new MockPaymentProvider();
  const confirmation = new PaymentConfirmationService(
    appPool,
    new PaymentIntentService(appPool),
    posting,
    provider,
    ZERO_FEE_SCHEDULE
  );
  // Servicio de RESOLUCIÓN cableado en el processor (provider normal; resolve no
  // llama submitPayout). MISMO registro que apps/worker/src/main.ts.
  const resolvePayouts = new PayoutService(appPool, posting, provider);
  processor = new InboxProcessor(inboxPool, {});
  processor.register(MOCK_PROVIDER_NAME, createMockInboxRegistration(confirmation, resolvePayouts));

  // Servicio con banco-timeout para FABRICAR indeterminados (fondos en tránsito).
  const timeoutBank: PaymentProvider = {
    name: 'mock',
    submitPayment: () => Promise.reject(new Error('n/a')),
    submitPayout: () => Promise.reject(new ProviderTimeoutError('mock')),
  };
  timeoutPayouts = new PayoutService(appPool, posting, timeoutBank);

  org = (
    await adminPool.query<{ id: string }>(
      `INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id`,
      ['Payout Webhook Org', `org-${randomUUID()}`]
    )
  ).rows[0]!.id;
  merchant = (
    await adminPool.query<{ id: string }>(
      `INSERT INTO merchants (tenant_id, name) VALUES ($1, $2) RETURNING id`,
      [org, `pw-shop-${randomUUID().slice(0, 8)}`]
    )
  ).rows[0]!.id;
}, 30_000);

afterAll(async () => {
  await app.close();
  await Promise.all([appPool.end(), authPool.end(), adminPool.end(), inboxPool.end()]);
});

describe('webhook del banco resuelve payouts (F4-07c-ii)', () => {
  it('signed payout.paid -> durable ingest -> processor settles the indeterminate payout', async () => {
    const payoutId = await indeterminatePayout(100_000);
    expect(await payoutStatus(payoutId)).toBe('indeterminate');
    expect(await bal('payout.in_transit')).toBe(100_000n);

    const body = JSON.stringify({
      event_id: `evt-${randomUUID()}`,
      type: 'payout.paid',
      tenant_id: org,
      payout_id: payoutId,
      provider_ref: 'bank_confirmed_ref',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/providers/mock/webhook',
      headers: sign(body),
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true, duplicate: false });

    // Aún NO aplicado: la ingesta es durable, el procesamiento asíncrono.
    expect(await payoutStatus(payoutId)).toBe('indeterminate');

    const stats = await processor.runOnce();
    expect(stats.processed).toBeGreaterThanOrEqual(1);

    expect(await payoutStatus(payoutId)).toBe('paid');
    // settlePayout descargó el tránsito contra la caja: neto 0 (recibió 100k, pagó 100k).
    expect(await bal('payout.in_transit')).toBe(0n);
    expect(await bal('platform.cash')).toBe(0n);
  });

  it('signed payout.failed -> the funds return in full to the merchant', async () => {
    const payoutId = await indeterminatePayout(80_000);
    const body = JSON.stringify({
      event_id: `evt-${randomUUID()}`,
      type: 'payout.failed',
      tenant_id: org,
      payout_id: payoutId,
      failure_code: 'bank_rejected',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/providers/mock/webhook',
      headers: sign(body),
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    await processor.runOnce();

    expect(await payoutStatus(payoutId)).toBe('failed');
    expect(await bal(`merchant.available:${merchant}`)).toBe(80_000n); // fondos de vuelta
    expect(await bal('payout.in_transit')).toBe(0n);
  });

  it('a redelivery of the same event_id is a duplicate: durable once, applied once', async () => {
    const payoutId = await indeterminatePayout(20_000);
    const body = JSON.stringify({
      event_id: `evt-${randomUUID()}`,
      type: 'payout.paid',
      tenant_id: org,
      payout_id: payoutId,
      provider_ref: 'bank_ref_dup',
    });
    const first = await app.inject({
      method: 'POST',
      url: '/v1/providers/mock/webhook',
      headers: sign(body),
      payload: body,
    });
    expect(first.json().duplicate).toBe(false);
    const second = await app.inject({
      method: 'POST',
      url: '/v1/providers/mock/webhook',
      headers: sign(body),
      payload: body,
    });
    expect(second.json().duplicate).toBe(true);

    await processor.runOnce();
    expect(await payoutStatus(payoutId)).toBe('paid');
  });

  it('an invalid signature is rejected with the catalog envelope and persists NOTHING', async () => {
    const body = JSON.stringify({
      event_id: `evt-${randomUUID()}`,
      type: 'payout.paid',
      tenant_id: org,
      payout_id: randomUUID(),
      provider_ref: 'nope',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/providers/mock/webhook',
      headers: {
        'x-fluvia-timestamp': String(Date.now()),
        'x-fluvia-signature': 'deadbeef',
        'content-type': 'application/json',
      },
      payload: body,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('invalid_signature');
    const rows = await adminPool.query(
      `SELECT 1 FROM provider_events WHERE raw_body::text LIKE '%' || $1 || '%'`,
      [JSON.parse(body).event_id]
    );
    expect(rows.rowCount).toBe(0);
  });
});
