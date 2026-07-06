import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@fluvia/config';
import { createPool, type Pool } from '@fluvia/db';
import { AuthService } from '@fluvia/auth';
import { ApiKeyService, IdentityService } from '@fluvia/identity';
import { InboxProcessor, signWebhookPayload } from '@fluvia/inbox';
import { LedgerService, PostingService } from '@fluvia/ledger';
import {
  MOCK_PROVIDER_NAME,
  MockPaymentProvider,
  PaymentConfirmationService,
  PaymentIntentService,
  PayoutService,
  ZERO_FEE_SCHEDULE,
  createMockInboxRegistration,
} from '@fluvia/payments-core';
import { buildApp } from '../src/app.js';

/**
 * F3-03b — la cadena asincrona COMPLETA sobre HTTP real:
 * confirm(tok_pse) -> webhook FIRMADO del proveedor -> ingesta durable ->
 * InboxProcessor (primer handler real) -> attempt/intent resueltos con
 * captura contable. Exactamente el cableado de produccion (el processor del
 * worker usa este mismo registro).
 */

let app: FastifyInstance;
let appPool: Pool;
let authPool: Pool;
let adminPool: Pool;
let inboxPool: Pool;
let processor: InboxProcessor;
let secret: string;

let org: string;
let merchantId: string;
let apiKey: string;

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
  const posting = new PostingService(new LedgerService(appPool), appPool);
  const provider = new MockPaymentProvider();
  const confirmation = new PaymentConfirmationService(
    appPool,
    intents,
    posting,
    provider,
    ZERO_FEE_SCHEDULE
  );
  const payouts = new PayoutService(appPool, posting, provider);
  processor = new InboxProcessor(inboxPool, {});
  processor.register(MOCK_PROVIDER_NAME, createMockInboxRegistration(confirmation, payouts));

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
