import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@fluvia/config';
import { createPool, withTenantTransaction, type Pool } from '@fluvia/db';
import { AuthService } from '@fluvia/auth';
import { ApiKeyService, IdentityService } from '@fluvia/identity';
import { LedgerService, PostingService } from '@fluvia/ledger';
import { Money } from '@fluvia/money';
import {
  MockPaymentProvider,
  PaymentIntentService,
  RefundService,
  type PaymentProvider,
  type RefundPaymentInput,
} from '@fluvia/payments-core';
import { buildApp } from '../src/app.js';

/**
 * Integridad de devoluciones sobre HTTP real + PG real, por LOS DOS puntos de
 * entrada que crean refunds: el plano de API key (`POST /v1/refunds`) y el
 * plano de sesión (`POST /v1/organizations/:orgId/refunds`, el que usa el BFF
 * del POS). MockProvider; ningún cobro real.
 *
 *  - Un refund `indeterminate` reserva el cupo del cobro: una segunda
 *    solicitud es 422 por ambos planos, aunque el comercio tenga saldo de otros
 *    cobros (el guard del ledger NO lo habría impedido).
 *  - Dos solicitudes en paralelo (una por cada plano, keys distintas): exactamente
 *    un refund.
 *  - Doble envío con la MISMA Idempotency-Key en paralelo: un solo refund, un
 *    solo par de asientos.
 */

let app: FastifyInstance;
let appPool: Pool;
let authPool: Pool;
let adminPool: Pool;
let posting: PostingService;
let intents: PaymentIntentService;

let org: string;
let apiKey: string;

const PASSWORD = 'refund integrity 88';

/** Adapter con refund que LANZA (la petición pudo salir): deja `indeterminate`. */
class UnknownRefundProvider implements PaymentProvider {
  readonly name = 'mock';
  private readonly mock = new MockPaymentProvider();
  submitPayment(input: Parameters<PaymentProvider['submitPayment']>[0]) {
    return this.mock.submitPayment(input);
  }
  refundPayment(_input: RefundPaymentInput): Promise<never> {
    return Promise.reject(new Error('connection reset'));
  }
}

async function sessionHeaders(role: string) {
  const email = `rfi-${randomUUID().slice(0, 12)}@example.com`;
  const reg = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email, password: PASSWORD },
  });
  const { user_id, verification_token } = reg.json();
  await app.inject({
    method: 'POST',
    url: '/v1/auth/verify-email',
    payload: { token: verification_token },
  });
  await adminPool.query('INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)', [
    org,
    user_id,
    role,
  ]);
  const login = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email, password: PASSWORD },
  });
  return { authorization: `Bearer ${login.json().session_token as string}` };
}

async function freshMerchant(): Promise<string> {
  const res = await adminPool.query<{ id: string }>(
    'INSERT INTO merchants (tenant_id, name) VALUES ($1, $2) RETURNING id',
    [org, `rfi-shop-${randomUUID().slice(0, 8)}`]
  );
  return res.rows[0]!.id;
}

/** Cobro por el plano de API key (tok_approve ⇒ succeeded) + liberación sandbox. */
async function chargeReleased(merchantId: string, amount: number): Promise<string> {
  const created = await app.inject({
    method: 'POST',
    url: '/v1/payment_intents',
    headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': `pi-${randomUUID()}` },
    payload: { merchant_id: merchantId, amount, currency: 'COP' },
  });
  expect(created.statusCode).toBe(201);
  const intentId = created.json().id as string;
  const confirmed = await app.inject({
    method: 'POST',
    url: `/v1/payment_intents/${intentId}/confirm`,
    headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': `cf-${randomUUID()}` },
    payload: { payment_method_token: 'tok_approve' },
  });
  expect(confirmed.statusCode).toBe(200);
  await posting.releaseSettlement({
    tenantId: org,
    merchantId,
    idempotencyKey: `settle:${intentId}`,
    sourceType: 'settlement',
    sourceId: intentId,
    amount: Money.of(amount, 'COP'),
  });
  return intentId;
}

async function indeterminateRefund(paymentIntentId: string, amount?: bigint) {
  const svc = new RefundService(appPool, intents, posting, new UnknownRefundProvider());
  const r = await withTenantTransaction(appPool, org, (c) =>
    svc.beginIn(c, org, { paymentIntentId, amount })
  );
  await svc.execute(org, r.id);
  return r.id;
}

async function refundsOf(paymentIntentId: string) {
  const res = await adminPool.query<{ id: string; amount: string; status: string }>(
    `SELECT id, amount::text, status FROM refunds WHERE payment_intent_id = $1 ORDER BY created_at, id`,
    [paymentIntentId]
  );
  return res.rows;
}

async function refundLedgerTxCount(paymentIntentId: string): Promise<number> {
  const res = await adminPool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ledger_transactions t
     JOIN refunds r ON r.id::text = t.source_id::text
     WHERE t.source_type = 'refund' AND r.payment_intent_id = $1`,
    [paymentIntentId]
  );
  return res.rows[0]!.n;
}

async function merchantAvailable(merchantId: string): Promise<bigint> {
  const chart = await posting.ensureChart(org, merchantId, 'COP');
  const ledger = new LedgerService(appPool);
  return BigInt((await ledger.getBalance(org, chart['merchant.available'])).available);
}

const viaApiKey = (key: string, payload: object) =>
  app.inject({
    method: 'POST',
    url: '/v1/refunds',
    headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': key },
    payload,
  });
const viaSession = (headers: Record<string, string>, key: string, payload: object) =>
  app.inject({
    method: 'POST',
    url: `/v1/organizations/${org}/refunds`,
    headers: { ...headers, 'idempotency-key': key },
    payload,
  });

let finance: Record<string, string>;

beforeAll(async () => {
  // Fee 0 (como refund-routes.test.ts): el cupo se mide sobre el bruto
  // capturado y la liberación sandbox libera ese mismo bruto.
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error', PLATFORM_FEE_BPS: '0' });
  appPool = createPool({ connectionString: config.db.app, max: 8 });
  authPool = createPool({ connectionString: config.db.auth, max: 4 });
  adminPool = createPool({ connectionString: config.db.admin, max: 2 });
  const apiKeyService = new ApiKeyService(appPool);
  posting = new PostingService(new LedgerService(appPool), appPool);
  intents = new PaymentIntentService(appPool);
  app = buildApp({
    config,
    appPool,
    authService: new AuthService(authPool),
    identityService: new IdentityService(appPool),
    apiKeyService,
  });
  await app.ready();
  const o = await adminPool.query<{ id: string }>(
    'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id',
    ['Refund Integrity', `org-${randomUUID()}`]
  );
  org = o.rows[0]!.id;
  apiKey = (await apiKeyService.create(org, { label: 'rfi', scopes: ['read', 'payments:write'] }))
    .secret;
  finance = await sessionHeaders('finance');
}, 30_000);

afterAll(async () => {
  await app.close();
  await Promise.all([appPool.end(), authPool.end(), adminPool.end()]);
});

describe('refund indeterminate + otra solicitud sobre el mismo cobro', () => {
  it('both entry points answer 422 while the first refund is indeterminate (merchant has funds from another charge)', async () => {
    const merchant = await freshMerchant();
    await chargeReleased(merchant, 100_000); // saldo de OTRO cobro
    const pi = await chargeReleased(merchant, 100_000);
    const r1 = await indeterminateRefund(pi);
    const availBefore = await merchantAvailable(merchant);
    expect(availBefore).toBe(100_000n); // el ledger SÍ permitiría otra reserva

    // Lo que el comercio ve por GET: `indeterminate` (el POS lo bloquea).
    const get = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${org}/refunds?payment_intent_id=${pi}`,
      headers: finance,
    });
    expect(get.json().data.map((r: { status: string }) => r.status)).toEqual(['indeterminate']);

    const api = await viaApiKey(`rf-${randomUUID()}`, { payment_intent_id: pi });
    expect(api.statusCode).toBe(422);
    expect(api.json().error.code).toBe('refund_amount_exceeds_remaining');

    const session = await viaSession(finance, `rf-${randomUUID()}`, {
      payment_intent_id: pi,
      amount: 100_000,
    });
    expect(session.statusCode).toBe(422);
    expect(session.json().error.code).toBe('refund_amount_exceeds_remaining');

    const minimal = await viaSession(finance, `rf-${randomUUID()}`, {
      payment_intent_id: pi,
      amount: 1,
    });
    expect(minimal.statusCode).toBe(422);

    expect(await refundsOf(pi)).toEqual([{ id: r1, amount: '100000', status: 'indeterminate' }]);
    expect(await refundLedgerTxCount(pi)).toBe(1); // solo la reserva de r1
    expect(await merchantAvailable(merchant)).toBe(availBefore);
    const intent = await intents.get(org, pi);
    expect(intent.amountCaptured).toBe('100000');
    expect(intent.amountRefunded).toBe('0');
  });

  it('partial: 30% indeterminate ⇒ 80% is 422 by both planes, 70% is accepted', async () => {
    const merchant = await freshMerchant();
    await chargeReleased(merchant, 100_000);
    const pi = await chargeReleased(merchant, 100_000);
    await indeterminateRefund(pi, 30_000n);

    expect(
      (await viaApiKey(`rf-${randomUUID()}`, { payment_intent_id: pi, amount: 80_000 })).statusCode
    ).toBe(422);
    expect(
      (await viaSession(finance, `rf-${randomUUID()}`, { payment_intent_id: pi, amount: 80_000 }))
        .statusCode
    ).toBe(422);
    const ok = await viaSession(finance, `rf-${randomUUID()}`, {
      payment_intent_id: pi,
      amount: 70_000,
    });
    expect(ok.statusCode).toBe(201);
    const live = (await refundsOf(pi)).filter(
      (r) => r.status !== 'failed' && r.status !== 'canceled'
    );
    expect(live.reduce((a, r) => a + BigInt(r.amount), 0n)).toBeLessThanOrEqual(100_000n);
  });
});

describe('concurrencia e idempotencia por HTTP', () => {
  it('two full refunds in parallel, one per plane (distinct keys): exactly one 201 and one rejection', async () => {
    const merchant = await freshMerchant();
    await chargeReleased(merchant, 100_000);
    const pi = await chargeReleased(merchant, 100_000);
    const [a, b] = await Promise.all([
      viaApiKey(`rf-${randomUUID()}`, { payment_intent_id: pi, amount: 100_000 }),
      viaSession(finance, `rf-${randomUUID()}`, { payment_intent_id: pi, amount: 100_000 }),
    ]);
    const [ok, rejected] = a.statusCode === 201 ? [a, b] : [b, a];
    expect(ok.statusCode).toBe(201);
    // El perdedor depende del entrelazado: si toma el lock del intent con el
    // refund ganador aún vivo → 422 por remanente; si el ganador ya completó
    // sus dos fases (intent `refunded`) → 409 por estado. Ambos rechazan.
    expect([
      [422, 'refund_amount_exceeds_remaining'],
      [409, 'invalid_state_transition'],
    ]).toContainEqual([rejected.statusCode, rejected.json().error.code]);
    expect((await refundsOf(pi)).map((r) => r.amount)).toEqual(['100000']);
  });

  it('double submit with the SAME Idempotency-Key in parallel: one refund, one request+settle pair', async () => {
    const merchant = await freshMerchant();
    const pi = await chargeReleased(merchant, 40_000);
    const key = `rf-${randomUUID()}`;
    const payload = { payment_intent_id: pi, amount: 40_000 };
    const [a, b] = await Promise.all([
      viaSession(finance, key, payload),
      viaSession(finance, key, payload),
    ]);
    const codes = [a.statusCode, b.statusCode].sort();
    // Replay exacto (201/201 con el mismo id) o el segundo ve la key en vuelo (409).
    expect([
      [201, 201],
      [201, 409],
    ]).toContainEqual(codes);
    if (codes[1] === 201) expect(a.json().id).toBe(b.json().id);
    const rows = await refundsOf(pi);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('succeeded');
    expect(await refundLedgerTxCount(pi)).toBe(2); // request + settle, jamás más

    // Un tercer envío posterior con la misma key: replay, sin nuevo refund.
    const again = await viaSession(finance, key, payload);
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotency-replayed']).toBe('true');
    expect(await refundsOf(pi)).toHaveLength(1);
  });

  it('same key on the API-key plane in parallel: one refund', async () => {
    const merchant = await freshMerchant();
    const pi = await chargeReleased(merchant, 25_000);
    const key = `rf-${randomUUID()}`;
    const payload = { payment_intent_id: pi };
    const res = await Promise.all([viaApiKey(key, payload), viaApiKey(key, payload)]);
    expect(res.every((r) => r.statusCode === 201 || r.statusCode === 409)).toBe(true);
    expect(await refundsOf(pi)).toHaveLength(1);
    expect(await refundLedgerTxCount(pi)).toBe(2);
  });
});
