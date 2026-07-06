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
  DisputeService,
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
 * F3-03b + F4-07c-ii — la cadena asincrona COMPLETA sobre HTTP real:
 * confirm(tok_pse) -> webhook FIRMADO del proveedor -> ingesta durable ->
 * InboxProcessor (primer handler real) -> attempt/intent resueltos con captura
 * contable. El MISMO endpoint firmado + processor resuelve también payouts
 * `indeterminate` (payout.paid/failed -> resolveFromProvider). UN SOLO processor
 * (como en producción): dos processors 'mock' concurrentes competirían por los
 * mismos eventos (el claim no filtra por provider), por eso ambos flujos viven
 * en este archivo y comparten el registro.
 */

let app: FastifyInstance;
let appPool: Pool;
let authPool: Pool;
let adminPool: Pool;
let inboxPool: Pool;
let processor: InboxProcessor;
let posting: PostingService;
let timeoutPayouts: PayoutService;
let secret: string;

let org: string;
let merchantId: string;
let apiKey: string;

const cop = (n: number) => Money.of(n, 'COP');

function sign(rawBody: string) {
  const ts = Date.now();
  return {
    'x-fluvia-timestamp': String(ts),
    'x-fluvia-signature': signWebhookPayload(secret, ts, rawBody),
    'content-type': 'application/json',
  };
}

async function confirmPse(): Promise<{ intentId: string; attemptId: string; ref: string }> {
  const created = await app.inject({
    method: 'POST',
    url: '/v1/payment_intents',
    headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': `wh-${randomUUID()}` },
    payload: { merchant_id: merchantId, amount: 95_000, currency: 'COP' },
  });
  const intentId = created.json().id as string;
  const confirmed = await app.inject({
    method: 'POST',
    url: `/v1/payment_intents/${intentId}/confirm`,
    headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': `wh-c-${randomUUID()}` },
    payload: { payment_method_token: 'tok_pse' },
  });
  const attemptId = confirmed.json().attempt_id as string;
  const ref = (
    await adminPool.query<{ provider_ref: string }>(
      `SELECT provider_ref FROM payment_attempts WHERE id = $1`,
      [attemptId]
    )
  ).rows[0]!.provider_ref;
  return { intentId, attemptId, ref };
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

  // MISMO cableado que apps/worker/src/main.ts.
  const intents = new PaymentIntentService(appPool);
  posting = new PostingService(new LedgerService(appPool), appPool);
  const provider = new MockPaymentProvider();
  const confirmation = new PaymentConfirmationService(
    appPool,
    intents,
    posting,
    provider,
    ZERO_FEE_SCHEDULE
  );
  const payouts = new PayoutService(appPool, posting, provider);
  const disputes = new DisputeService(appPool, posting);
  processor = new InboxProcessor(inboxPool, {});
  processor.register(
    MOCK_PROVIDER_NAME,
    createMockInboxRegistration(confirmation, payouts, disputes)
  );

  // Banco con timeout para FABRICAR payouts `indeterminate` (fondos en tránsito).
  const timeoutBank: PaymentProvider = {
    name: 'mock',
    submitPayment: () => Promise.reject(new Error('n/a')),
    submitPayout: () => Promise.reject(new ProviderTimeoutError('mock')),
  };
  timeoutPayouts = new PayoutService(appPool, posting, timeoutBank);

  org = (
    await adminPool.query<{ id: string }>(
      `INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id`,
      ['Webhook Org', `org-${randomUUID()}`]
    )
  ).rows[0]!.id;
  merchantId = (
    await adminPool.query<{ id: string }>(
      `INSERT INTO merchants (tenant_id, name) VALUES ($1, $2) RETURNING id`,
      [org, `wh-shop-${randomUUID().slice(0, 8)}`]
    )
  ).rows[0]!.id;
  apiKey = (
    await new ApiKeyService(appPool).create(org, {
      label: 'wh',
      scopes: ['read', 'payments:write'],
    })
  ).secret;
}, 30_000);

afterAll(async () => {
  await app.close();
  await Promise.all([appPool.end(), authPool.end(), adminPool.end(), inboxPool.end()]);
});

describe('cadena asincrona completa (F3-03b)', () => {
  it('signed webhook -> durable ingest -> processor applies -> intent succeeded + captured', async () => {
    const { intentId, attemptId, ref } = await confirmPse();

    const body = JSON.stringify({
      event_id: `evt-${randomUUID()}`,
      type: 'payment.succeeded',
      tenant_id: org,
      attempt_id: attemptId,
      provider_ref: ref,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/providers/mock/webhook',
      headers: sign(body),
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true, duplicate: false });

    // Aun NO aplicado: la ingesta es durable, el procesamiento asincrono.
    const before = await adminPool.query<{ status: string }>(
      `SELECT status FROM payment_attempts WHERE id = $1`,
      [attemptId]
    );
    expect(before.rows[0]!.status).toBe('submitted');

    const stats = await processor.runOnce();
    expect(stats.processed).toBeGreaterThanOrEqual(1);

    const intent = await app.inject({
      method: 'GET',
      url: `/v1/payment_intents/${intentId}`,
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(intent.json().status).toBe('succeeded');
    expect(intent.json().amount_captured).toBe(95_000);
  });

  it('redelivery of the same event_id is a duplicate: durable once, applied once', async () => {
    const { attemptId, ref } = await confirmPse();
    const body = JSON.stringify({
      event_id: `evt-${randomUUID()}`,
      type: 'payment.failed',
      tenant_id: org,
      attempt_id: attemptId,
      provider_ref: ref,
      failure_code: 'card_declined',
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
    const att = await adminPool.query<{ status: string; last_error: string | null }>(
      `SELECT status, last_error FROM payment_attempts WHERE id = $1`,
      [attemptId]
    );
    expect(att.rows[0]!.status).toBe('failed');
  });

  it('an invalid signature is rejected with the catalog envelope and persists NOTHING', async () => {
    const body = JSON.stringify({
      event_id: `evt-${randomUUID()}`,
      type: 'payment.succeeded',
      tenant_id: org,
      attempt_id: randomUUID(),
      provider_ref: 'mock_x',
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

  it('a late webhook for an already-resolved attempt lands as ignored_out_of_order', async () => {
    const { intentId, attemptId, ref } = await confirmPse();
    const ok = JSON.stringify({
      event_id: `evt-${randomUUID()}`,
      type: 'payment.succeeded',
      tenant_id: org,
      attempt_id: attemptId,
      provider_ref: ref,
    });
    await app.inject({
      method: 'POST',
      url: '/v1/providers/mock/webhook',
      headers: sign(ok),
      payload: ok,
    });
    await processor.runOnce();

    // Evento CONTRADICTORIO tardio (event_id nuevo): no re-abre nada.
    const late = JSON.stringify({
      event_id: `evt-${randomUUID()}`,
      type: 'payment.failed',
      tenant_id: org,
      attempt_id: attemptId,
      provider_ref: ref,
      failure_code: 'card_declined',
    });
    await app.inject({
      method: 'POST',
      url: '/v1/providers/mock/webhook',
      headers: sign(late),
      payload: late,
    });
    await processor.runOnce();

    const intent = await app.inject({
      method: 'GET',
      url: `/v1/payment_intents/${intentId}`,
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(intent.json().status).toBe('succeeded');
    const row = await adminPool.query<{ status: string; result: string | null }>(
      `SELECT status, result FROM provider_events
       WHERE provider = 'mock' AND raw_body::text LIKE '%' || $1 || '%'`,
      [JSON.parse(late).event_id]
    );
    expect(row.rows[0]!.result).toContain('ignored_out_of_order');
  });
});

/** Deja `amount` en merchant.available Y en platform.cash (money-in completo). */
async function seedAvailable(amount: number): Promise<void> {
  const src = randomUUID();
  const m = cop(amount);
  await posting.capturePayment({
    tenantId: org,
    merchantId,
    idempotencyKey: `cap:${src}`,
    sourceType: 'payment_attempt',
    sourceId: src,
    amount: m,
  });
  await posting.receiveProviderSettlement({
    tenantId: org,
    merchantId,
    idempotencyKey: `prov:${src}`,
    sourceType: 'settlement',
    sourceId: src,
    amount: m,
  });
  await posting.releaseSettlement({
    tenantId: org,
    merchantId,
    idempotencyKey: `settle:${src}`,
    sourceType: 'settlement',
    sourceId: src,
    amount: m,
  });
}

/** Crea un payout y lo lleva a `indeterminate` (banco con timeout). */
async function indeterminatePayout(amount: number): Promise<string> {
  await seedAvailable(amount);
  const po = await timeoutPayouts.create(org, {
    merchantId,
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

    // Aun NO aplicado: la ingesta es durable, el procesamiento asincrono.
    expect(await payoutStatus(payoutId)).toBe('indeterminate');

    const stats = await processor.runOnce();
    expect(stats.processed).toBeGreaterThanOrEqual(1);

    expect(await payoutStatus(payoutId)).toBe('paid');
    // settlePayout descargo el transito contra la caja: neto 0.
    expect(await bal('payout.in_transit')).toBe(0n);
    expect(await bal('platform.cash')).toBe(0n);
  });

  it('signed payout.failed -> the funds return in full to the merchant', async () => {
    const before = await bal(`merchant.available:${merchantId}`);
    const payoutId = await indeterminatePayout(80_000);
    const body = JSON.stringify({
      event_id: `evt-${randomUUID()}`,
      type: 'payout.failed',
      tenant_id: org,
      payout_id: payoutId,
      failure_code: 'bank_rejected',
    });
    await app.inject({
      method: 'POST',
      url: '/v1/providers/mock/webhook',
      headers: sign(body),
      payload: body,
    });
    await processor.runOnce();

    expect(await payoutStatus(payoutId)).toBe('failed');
    // seed(+80k) -> emit(-80k) -> failPayout(+80k): los fondos sembrados vuelven
    // íntegros al comercio (el payout falló), así que el disponible sube 80k.
    expect(await bal(`merchant.available:${merchantId}`)).toBe(before + 80_000n);
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
});

/** Comercio nuevo con disponible + clearing fundados (captura + release, sin
 * settle a caja: una disputa perdida forfeita a provider.clearing). */
async function seededMerchant(amount: number): Promise<string> {
  const merchant = (
    await adminPool.query<{ id: string }>(
      `INSERT INTO merchants (tenant_id, name) VALUES ($1, $2) RETURNING id`,
      [org, `wh-dp-${randomUUID().slice(0, 8)}`]
    )
  ).rows[0]!.id;
  const src = randomUUID();
  const m = cop(amount);
  await posting.capturePayment({
    tenantId: org,
    merchantId: merchant,
    idempotencyKey: `dcap:${src}`,
    sourceType: 'payment_attempt',
    sourceId: src,
    amount: m,
  });
  await posting.releaseSettlement({
    tenantId: org,
    merchantId: merchant,
    idempotencyKey: `drel:${src}`,
    sourceType: 'settlement',
    sourceId: src,
    amount: m,
  });
  return merchant;
}

async function ingestSigned(payload: Record<string, unknown>): Promise<void> {
  const body = JSON.stringify(payload);
  const res = await app.inject({
    method: 'POST',
    url: '/v1/providers/mock/webhook',
    headers: sign(body),
    payload: body,
  });
  expect(res.statusCode).toBe(200);
}

async function disputeByRef(ref: string): Promise<{ id: string; status: string } | undefined> {
  const res = await adminPool.query<{ id: string; status: string }>(
    `SELECT id, status FROM disputes WHERE provider = 'mock' AND provider_ref = $1`,
    [ref]
  );
  return res.rows[0];
}

describe('webhook del banco abre y resuelve disputas (F4-08c)', () => {
  it('signed dispute.opened -> processor holds funds; dispute.won returns them', async () => {
    const merchant = await seededMerchant(100_000);
    const ref = `dp_${randomUUID().slice(0, 8)}`;
    await ingestSigned({
      event_id: `evt-${randomUUID()}`,
      type: 'dispute.opened',
      tenant_id: org,
      merchant_id: merchant,
      amount: 30_000,
      currency: 'COP',
      provider_ref: ref,
      reason: 'fraudulent',
    });
    // Ingesta durable, procesamiento asincrono: aun sin disputa.
    expect(await disputeByRef(ref)).toBeUndefined();

    await processor.runOnce();
    const opened = await disputeByRef(ref);
    expect(opened!.status).toBe('open');
    // Apartado: disponible bajo, reserva de disputa subio.
    expect(await bal(`merchant.available:${merchant}`)).toBe(70_000n);
    expect(await bal(`dispute.reserve:${merchant}`)).toBe(30_000n);

    await ingestSigned({
      event_id: `evt-${randomUUID()}`,
      type: 'dispute.won',
      tenant_id: org,
      dispute_id: opened!.id,
      provider_ref: ref,
    });
    await processor.runOnce();
    expect((await disputeByRef(ref))!.status).toBe('won');
    // Ganada: lo apartado vuelve integro.
    expect(await bal(`merchant.available:${merchant}`)).toBe(100_000n);
    expect(await bal(`dispute.reserve:${merchant}`)).toBe(0n);
  });

  it('signed dispute.lost forfeits the held funds (money leaves via the provider)', async () => {
    const merchant = await seededMerchant(100_000);
    const ref = `dp_${randomUUID().slice(0, 8)}`;
    await ingestSigned({
      event_id: `evt-${randomUUID()}`,
      type: 'dispute.opened',
      tenant_id: org,
      merchant_id: merchant,
      amount: 40_000,
      currency: 'COP',
      provider_ref: ref,
    });
    await processor.runOnce();
    const opened = await disputeByRef(ref);

    await ingestSigned({
      event_id: `evt-${randomUUID()}`,
      type: 'dispute.lost',
      tenant_id: org,
      dispute_id: opened!.id,
      provider_ref: ref,
    });
    await processor.runOnce();
    expect((await disputeByRef(ref))!.status).toBe('lost');
    // Perdida: el disponible NO se recupera (el dinero se fue); reserva a 0.
    expect(await bal(`merchant.available:${merchant}`)).toBe(60_000n);
    expect(await bal(`dispute.reserve:${merchant}`)).toBe(0n);
  });

  it('dispute.opened is idempotent by provider_ref: two events, one dispute, one hold', async () => {
    const merchant = await seededMerchant(100_000);
    const ref = `dp_${randomUUID().slice(0, 8)}`;
    const openBody = (eventId: string) => ({
      event_id: eventId,
      type: 'dispute.opened',
      tenant_id: org,
      merchant_id: merchant,
      amount: 30_000,
      currency: 'COP',
      provider_ref: ref,
    });
    // Dos eventos DISTINTOS (distinto event_id) para el MISMO provider_ref — el
    // banco reenviando, o el crash-retry del inbox: jamas doble-abre.
    await ingestSigned(openBody(`evt-${randomUUID()}`));
    await ingestSigned(openBody(`evt-${randomUUID()}`));
    await processor.runOnce();
    await processor.runOnce();

    const rows = await adminPool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM disputes WHERE provider = 'mock' AND provider_ref = $1`,
      [ref]
    );
    expect(Number(rows.rows[0]!.n)).toBe(1);
    // Un solo hold: el disponible bajo 30k, no 60k.
    expect(await bal(`merchant.available:${merchant}`)).toBe(70_000n);
    expect(await bal(`dispute.reserve:${merchant}`)).toBe(30_000n);
  });
});
