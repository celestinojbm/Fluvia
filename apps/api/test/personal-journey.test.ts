import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@fluvia/config';
import { createPool, type Pool } from '@fluvia/db';
import { AuthService } from '@fluvia/auth';
import { ApiKeyService, IdentityService } from '@fluvia/identity';
import { buildApp } from '../src/app.js';

/**
 * Recorrido de ACEPTACIÓN de la jornada integral por HTTP, con el backend
 * real, PostgreSQL y adaptadores simulados:
 *
 *   cliente registrado → ingreso confirmado → garantía bloqueada → límite
 *   aprobado → tarjeta virtual → compra en comercio Fluvia (checkout del
 *   comercio, otra organización) → autorización y captura → el comercio ve
 *   el resultado → el cliente ve deuda y cuotas → pago de cuota → devolución
 *   parcial → conciliación y auditoría.
 *
 * Más: separación de planos de autenticación, aislamiento entre clientes y
 * organizaciones, step-up, tarjeta bloqueada, fondos insuficientes, límite
 * excedido y duplicados.
 */
let app: FastifyInstance;
let appPool: Pool;
let authPool: Pool;
let adminPool: Pool;
let program: string;
let merchantOrg: string;
let otherOrg: string;
let merchantId: string;

const PASSWORD = 'jornada integral 2026';
type Headers = Record<string, string>;
let opOwner: { userId: string; headers: Headers };
let opFinance: { userId: string; headers: Headers };
let opSupport: { userId: string; headers: Headers };
let opAnalyst: { userId: string; headers: Headers };
let merchantOwner: { userId: string; headers: Headers };
let otherOwner: { userId: string; headers: Headers };

async function createOrg(name: string): Promise<string> {
  const res = await adminPool.query<{ id: string }>(
    'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id',
    [name, `org-${randomUUID()}`]
  );
  return res.rows[0]!.id;
}

async function sessionUser(role: string, orgId: string) {
  const email = `op-${randomUUID().slice(0, 12)}@example.com`;
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
    orgId,
    user_id,
    role,
  ]);
  const login = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email, password: PASSWORD },
  });
  const headers = { authorization: `Bearer ${login.json().session_token as string}` };
  return { userId: user_id as string, headers };
}

async function stepUp(h: Headers) {
  const r = await app.inject({
    method: 'POST',
    url: '/v1/auth/step-up/password',
    headers: h,
    payload: { password: PASSWORD },
  });
  expect(r.statusCode).toBe(200);
}

const idem = () => ({ 'idempotency-key': `k-${randomUUID()}` });

async function consumer(profile = 'B') {
  const email = `cli-${randomUUID().slice(0, 10)}@personal.fluvia.test`;
  const r = await app.inject({
    method: 'POST',
    url: `/v1/personal/programs/${program}/register`,
    payload: {
      email,
      password: 'clave del cliente 2026',
      display_name: 'María Pérez',
      synthetic_risk_profile: profile,
    },
  });
  expect(r.statusCode).toBe(201);
  return {
    id: r.json().consumer_id as string,
    email,
    headers: { authorization: `Bearer ${r.json().session as string}` },
  };
}

async function fundVia(c: { headers: Headers }, amount: number) {
  const f = await app.inject({
    method: 'POST',
    url: '/v1/personal/wallet/fundings',
    headers: { ...c.headers, ...idem() },
    payload: { amount: String(amount), currency: 'VES', method: 'mobile_payment' },
  });
  expect(f.statusCode).toBe(201);
  // El «banco» (proveedor de fondeo simulado) confirma por evento.
  const ev = await app.inject({
    method: 'POST',
    url: `/v1/programs/${program}/sandbox/provider-events`,
    headers: opOwner.headers,
    payload: {
      source: 'funding',
      event_type: 'funding.confirmed',
      payload: {
        provider_ref: f.json().funding.provider_ref,
        amount: String(amount),
        currency: 'VES',
      },
    },
  });
  expect(ev.json().status).toBe('applied');
}

async function balances(c: { headers: Headers }) {
  const r = await app.inject({
    method: 'GET',
    url: '/v1/personal/wallet/balances',
    headers: c.headers,
  });
  return r.json().data.find((b: { currency: string }) => b.currency === 'VES');
}

async function merchantSale(amount: number) {
  const link = await app.inject({
    method: 'POST',
    url: `/v1/organizations/${merchantOrg}/payment_links`,
    headers: { ...merchantOwner.headers, ...idem() },
    payload: {
      merchant_id: merchantId,
      amount,
      currency: 'VES',
      description: 'Compra de prueba',
      single_charge: true,
    },
  });
  expect(link.statusCode).toBe(201);
  const s = await app.inject({
    method: 'POST',
    url: `/v1/payment_links/${link.json().id}/sessions`,
  });
  return {
    linkId: link.json().id as string,
    sessionId: s.json().checkout_session_id as string,
    secret: s.json().client_secret as string,
  };
}

async function pay(sale: { sessionId: string; secret: string }, token: string) {
  return app.inject({
    method: 'POST',
    url: `/v1/checkout_sessions/${sale.sessionId}/confirm`,
    headers: { 'x-checkout-client-secret': sale.secret },
    payload: { payment_method_token: token },
  });
}

beforeAll(async () => {
  const bootEnv = { NODE_ENV: 'test', LOG_LEVEL: 'error' };
  const base = loadConfig(bootEnv);
  adminPool = createPool({ connectionString: base.db.admin, max: 2 });
  program = await createOrg('Fluvia Personal (programa sandbox)');
  merchantOrg = await createOrg('Bodega La Esquina');
  otherOrg = await createOrg('Otra organización');
  const config = loadConfig({ ...bootEnv, FLUVIA_PROGRAM_TENANT_ID: program });
  appPool = createPool({ connectionString: config.db.app, max: 8 });
  authPool = createPool({ connectionString: config.db.auth, max: 4 });
  app = buildApp({
    config,
    appPool,
    authPool,
    authService: new AuthService(authPool),
    identityService: new IdentityService(appPool),
    apiKeyService: new ApiKeyService(appPool),
    authRateLimits: {
      loginPerEmail: { max: 10_000, windowMs: 60_000 },
      loginPerIp: { max: 10_000, windowMs: 60_000 },
      registerPerIp: { max: 10_000, windowMs: 60_000 },
      mfaPerIp: { max: 10_000, windowMs: 60_000 },
    },
  });
  await app.ready();
  const m = await adminPool.query<{ id: string }>(
    `INSERT INTO merchants (tenant_id, name, default_currency) VALUES ($1, 'Bodega La Esquina', 'VES') RETURNING id`,
    [merchantOrg]
  );
  merchantId = m.rows[0]!.id;
  opOwner = await sessionUser('owner', program);
  opFinance = await sessionUser('finance', program);
  opSupport = await sessionUser('support', program);
  opAnalyst = await sessionUser('analyst', program);
  merchantOwner = await sessionUser('owner', merchantOrg);
  otherOwner = await sessionUser('owner', otherOrg);

  // Alta del programa: exige step-up.
  const noStep = await app.inject({
    method: 'POST',
    url: `/v1/programs/${program}/setup`,
    headers: opOwner.headers,
    payload: { name: 'Fluvia Personal', currencies: ['VES', 'USD'] },
  });
  expect(noStep.statusCode).toBe(403);
  await stepUp(opOwner.headers);
  const setup = await app.inject({
    method: 'POST',
    url: `/v1/programs/${program}/setup`,
    headers: opOwner.headers,
    payload: { name: 'Fluvia Personal', currencies: ['VES', 'USD'] },
  });
  expect(setup.statusCode).toBe(201);
}, 60_000);

afterAll(async () => {
  await app.close();
  await Promise.all([appPool.end(), authPool.end(), adminPool.end()]);
});

describe('planos de autenticación separados', () => {
  it('la sesión del cliente no abre rutas de organización ni de operación, y viceversa', async () => {
    const c = await consumer();
    expect(
      (await app.inject({ method: 'GET', url: '/v1/personal/me', headers: c.headers })).statusCode
    ).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url: `/v1/programs/${program}`, headers: c.headers }))
        .statusCode
    ).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url: '/v1/personal/me', headers: opOwner.headers }))
        .statusCode
    ).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/personal/me' })).json().error.code).toBe(
      'consumer_session_invalid'
    );
  });

  it('otra organización no ve el programa (404); un analista lee pero no actúa', async () => {
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/v1/programs/${program}`,
          headers: otherOwner.headers,
        })
      ).statusCode
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/v1/programs/${program}/consumers`,
          headers: opAnalyst.headers,
        })
      ).statusCode
    ).toBe(200);
    const r = await app.inject({
      method: 'POST',
      url: `/v1/programs/${program}/maintenance/overdue`,
      headers: opAnalyst.headers,
      payload: {},
    });
    expect(r.statusCode).toBe(403);
  });
});

describe('recorrido de aceptación completo', () => {
  it('de cliente nuevo a compra en cuotas, pago, devolución parcial, conciliación y auditoría', async () => {
    // 1. Cliente registrado + 2. ingreso confirmado por el proveedor.
    const c = await consumer('B');
    await fundVia(c, 1_500_000);
    let b = await balances(c);
    expect(b.available).toBe('1500000');

    // 3. Garantía bloqueada (dinero propio, no pago).
    const lock = await app.inject({
      method: 'POST',
      url: '/v1/personal/collateral/lock',
      headers: { ...c.headers, ...idem() },
      payload: { amount: '1000000', currency: 'VES' },
    });
    expect(lock.statusCode).toBe(201);

    // 4. Límite aprobado por la política de referencia (B ⇒ ×3), explicado.
    const appRes = await app.inject({
      method: 'POST',
      url: '/v1/personal/credit/applications',
      headers: { ...c.headers, ...idem() },
      payload: { currency: 'VES', requested_limit: '2000000' },
    });
    expect(appRes.statusCode).toBe(201);
    expect(appRes.json().application.status).toBe('approved');
    expect(appRes.json().application.decision.reasons.length).toBeGreaterThan(0);
    b = await balances(c);
    expect(b.available).toBe('500000');
    expect(b.collateral).toBe('1000000');
    expect(b.credit.available).toBe('2000000');

    // 5. Tarjeta virtual en sandbox (sin PAN/CVV en la respuesta).
    const card = await app.inject({
      method: 'POST',
      url: '/v1/personal/cards',
      headers: c.headers,
      payload: { currency: 'VES', form: 'virtual' },
    });
    expect(card.statusCode).toBe(201);
    expect(card.json().status).toBe('active');
    expect(JSON.stringify(card.json())).not.toMatch(/[0-9]{12,19}/);
    const cardId = card.json().id as string;

    // Oferta visible antes de aceptar; código de pago de un solo uso.
    const offer = await app.inject({
      method: 'GET',
      url: '/v1/personal/offers/installments?count=3&amount=600000&currency=VES',
      headers: c.headers,
    });
    expect(offer.json().down_payment).toBe('150000');
    expect(offer.json().installments).toHaveLength(3);
    const code = await app.inject({
      method: 'POST',
      url: '/v1/personal/payment-codes',
      headers: c.headers,
      payload: { card_id: cardId, mode: 'installments', installments_count: 3 },
    });
    expect(code.statusCode).toBe(201);
    expect(code.headers['cache-control']).toBe('no-store');

    // 6. Compra en comercio Fluvia (otra organización) + 7. autorización y captura.
    const sale = await merchantSale(600_000);
    const paid = await pay(sale, code.json().code);
    expect(paid.statusCode).toBe(200);
    expect(paid.json().status).toBe('completed');
    expect(paid.json().payment_intent.status).toBe('succeeded');

    // 8. El comercio consulta el resultado (su plano, sin ver datos del cliente).
    const intents = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${merchantOrg}/payment_intents`,
      headers: merchantOwner.headers,
    });
    const intent = intents
      .json()
      .data.find((i: { payment_link_id: string }) => i.payment_link_id === sale.linkId);
    expect(intent.status).toBe('succeeded');
    expect(JSON.stringify(intents.json())).not.toContain(c.email);

    // 9. El cliente ve deuda y cuotas (inicial 150k de saldo propio).
    b = await balances(c);
    expect(b.debt).toBe('450000');
    expect(b.available).toBe('350000');
    const plans = await app.inject({
      method: 'GET',
      url: '/v1/personal/credit/plans',
      headers: c.headers,
    });
    const plan = plans.json().data[0];
    expect(plan.merchant_name).toBe('Bodega La Esquina');
    expect(plan.installments.map((i: { amount: string }) => i.amount)).toEqual([
      '150000',
      '150000',
      '150000',
    ]);
    const overview = await app.inject({
      method: 'GET',
      url: '/v1/personal/overview',
      headers: c.headers,
    });
    expect(overview.json().upcoming).toHaveLength(3);

    // 10. Pago de cuota (idempotente: repetir con la misma clave no paga dos veces).
    const key = idem();
    const pay1 = await app.inject({
      method: 'POST',
      url: '/v1/personal/credit/repayments',
      headers: { ...c.headers, ...key },
      payload: { currency: 'VES', amount: '150000' },
    });
    expect(pay1.statusCode).toBe(201);
    const pay2 = await app.inject({
      method: 'POST',
      url: '/v1/personal/credit/repayments',
      headers: { ...c.headers, ...key },
      payload: { currency: 'VES', amount: '150000' },
    });
    expect(pay2.json().replayed).toBe(true);
    b = await balances(c);
    expect(b.debt).toBe('300000');
    expect(b.available).toBe('200000');

    // 11. Devolución parcial desde el comercio ⇒ reduce la deuda del cliente.
    await adminPool.query(`SELECT 1`);
    const settle = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${merchantOrg}/payment_intents/${intent.id}`,
      headers: merchantOwner.headers,
    });
    expect(settle.statusCode).toBe(200);
    // El comercio necesita saldo disponible para devolver (liquidación simulada
    // de lo que le corresponde: el bruto menos el fee de plataforma del sandbox).
    await releaseMerchant(intent.id, 600_000 - (600_000 * 200) / 10_000); // PLATFORM_FEE_BPS por defecto = 200
    const refund = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${merchantOrg}/refunds`,
      headers: { ...merchantOwner.headers, ...idem() },
      payload: { payment_intent_id: intent.id, amount: 200_000, reason: 'requested_by_customer' },
    });
    expect([200, 201]).toContain(refund.statusCode);
    b = await balances(c);
    expect(b.debt).toBe('100000');

    // 12. Conciliación y auditoría.
    const rec = await app.inject({
      method: 'POST',
      url: `/v1/programs/${program}/reconciliation/run`,
      headers: opFinance.headers,
    });
    expect(rec.json().checks.filter((x: { ok: boolean }) => !x.ok)).toEqual([]);
    const detail = await app.inject({
      method: 'GET',
      url: `/v1/programs/${program}/consumers/${c.id}`,
      headers: opSupport.headers,
    });
    const ids = detail.json().audit.map((a: { id: string }) => Number(a.id));
    expect(ids).toEqual([...ids].sort((x, y) => y - x)); // cronológico, más reciente primero
    const actions = detail.json().audit.map((a: { action: string }) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'consumer.registered',
        'collateral.locked',
        'credit.application_submitted',
        'card.issued',
        'credit.repayment_applied',
      ])
    );
  });
});

async function releaseMerchant(intentId: string, amount: number) {
  // Liquidación simulada del comercio (pendiente → disponible) por el camino
  // del ledger, como hacen las demás pruebas de devoluciones.
  const { LedgerService, PostingService } = await import('@fluvia/ledger');
  const { Money } = await import('@fluvia/money');
  const posting = new PostingService(new LedgerService(appPool), appPool);
  await posting.releaseSettlement({
    tenantId: merchantOrg,
    merchantId,
    idempotencyKey: `settle:${intentId}`,
    sourceType: 'settlement',
    sourceId: intentId,
    amount: Money.of(amount, 'VES'),
  });
}

describe('política versionada por HTTP', () => {
  it('una versión nueva se crea desde los parámetros devueltos (snake_case) y su activación exige otra persona', async () => {
    const list = await app.inject({
      method: 'GET',
      url: `/v1/programs/${program}/policies`,
      headers: opFinance.headers,
    });
    const active = list.json().data.find((p: { status: string }) => p.status === 'active');
    expect(active.params.currencies.VES).toBeDefined();
    await stepUp(opFinance.headers);
    const draft = await app.inject({
      method: 'POST',
      url: `/v1/programs/${program}/policies`,
      headers: opFinance.headers,
      payload: { code: active.code, params: { ...active.params, down_payment_bps: 3000 } },
    });
    expect(draft.statusCode).toBe(201);
    const prop = await app.inject({
      method: 'POST',
      url: `/v1/programs/${program}/policies/${draft.json().id}/propose-activation`,
      headers: opFinance.headers,
      payload: { reason: 'Prueba de doble firma' },
    });
    expect(prop.statusCode).toBe(201);
    const self = await app.inject({
      method: 'POST',
      url: `/v1/programs/${program}/approvals/${prop.json().approval_id}/decision`,
      headers: opFinance.headers,
      payload: { decision: 'approve' },
    });
    expect(self.json().error.code).toBe('four_eyes_required');
    // Otra persona la RECHAZA (la suite sigue con la política de referencia).
    await stepUp(opOwner.headers);
    const other = await app.inject({
      method: 'POST',
      url: `/v1/programs/${program}/approvals/${prop.json().approval_id}/decision`,
      headers: opOwner.headers,
      payload: { decision: 'reject' },
    });
    expect(other.json().status).toBe('rejected');
  });
});

describe('rechazos, límites, bloqueo y aislamiento', () => {
  it('fondos insuficientes y límite excedido: el comercio ve el rechazo', async () => {
    const c = await consumer('B');
    await fundVia(c, 10_000);
    const card = (
      await app.inject({
        method: 'POST',
        url: '/v1/personal/cards',
        headers: c.headers,
        payload: { currency: 'VES', form: 'virtual' },
      })
    ).json();
    const code = (
      await app.inject({
        method: 'POST',
        url: '/v1/personal/payment-codes',
        headers: c.headers,
        payload: { card_id: card.id, mode: 'wallet' },
      })
    ).json();
    const sale = await merchantSale(50_000);
    const r = await pay(sale, code.code);
    expect(r.json().payment_intent.status).toBe('failed');
    expect((await balances(c)).available).toBe('10000');

    const k = await consumer('C');
    await fundVia(k, 1_000_000);
    await app.inject({
      method: 'POST',
      url: '/v1/personal/collateral/lock',
      headers: { ...k.headers, ...idem() },
      payload: { amount: '1000000', currency: 'VES' },
    });
    await app.inject({
      method: 'POST',
      url: '/v1/personal/credit/applications',
      headers: { ...k.headers, ...idem() },
      payload: { currency: 'VES', requested_limit: '9000000' },
    });
    expect((await balances(k)).credit.approved_limit).toBe('2000000');
    const kc = (
      await app.inject({
        method: 'POST',
        url: '/v1/personal/cards',
        headers: k.headers,
        payload: { currency: 'VES', form: 'virtual', funding_mode: 'credit_only' },
      })
    ).json();
    const kcode = (
      await app.inject({
        method: 'POST',
        url: '/v1/personal/payment-codes',
        headers: k.headers,
        payload: { card_id: kc.id, mode: 'installments', installments_count: 6 },
      })
    ).json();
    const big = await merchantSale(5_000_000);
    expect((await pay(big, kcode.code)).json().payment_intent.status).toBe('failed');
    expect((await balances(k)).credit.reserved).toBe('0');
  });

  it('tarjeta bloqueada por Operaciones (con step-up) rechaza; el cliente no puede desbloquearla', async () => {
    const c = await consumer('B');
    await fundVia(c, 100_000);
    const card = (
      await app.inject({
        method: 'POST',
        url: '/v1/personal/cards',
        headers: c.headers,
        payload: { currency: 'VES', form: 'virtual' },
      })
    ).json();
    const code = (
      await app.inject({
        method: 'POST',
        url: '/v1/personal/payment-codes',
        headers: c.headers,
        payload: { card_id: card.id, mode: 'wallet' },
      })
    ).json();
    const noStep = await app.inject({
      method: 'POST',
      url: `/v1/programs/${program}/cards/${card.id}/block`,
      headers: opSupport.headers,
      payload: { reason: 'Sospecha de fraude' },
    });
    expect(noStep.statusCode).toBe(403);
    await stepUp(opSupport.headers);
    const blocked = await app.inject({
      method: 'POST',
      url: `/v1/programs/${program}/cards/${card.id}/block`,
      headers: opSupport.headers,
      payload: { reason: 'Sospecha de fraude' },
    });
    expect(blocked.json().status).toBe('blocked');
    expect((await pay(await merchantSale(1_000), code.code)).json().payment_intent.status).toBe(
      'failed'
    );
    const self = await app.inject({
      method: 'POST',
      url: `/v1/personal/cards/${card.id}/unblock`,
      headers: c.headers,
      payload: { reason: 'Fui yo' },
    });
    expect(self.statusCode).toBe(409);
  });

  it('un cliente no ve la tarjeta de otro; operación de otra organización tampoco', async () => {
    const a = await consumer();
    const bcons = await consumer();
    const card = (
      await app.inject({
        method: 'POST',
        url: '/v1/personal/cards',
        headers: a.headers,
        payload: { currency: 'VES', form: 'virtual' },
      })
    ).json();
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/v1/personal/cards/${card.id}`,
          headers: bcons.headers,
        })
      ).statusCode
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/v1/programs/${otherOrg}/cards/${card.id}`,
          headers: otherOwner.headers,
        })
      ).statusCode
    ).toBe(404);
    const transfer = await app.inject({
      method: 'POST',
      url: '/v1/personal/wallet/transfers',
      headers: { ...bcons.headers, ...idem() },
      payload: { to_email: a.email, amount: '1', currency: 'VES' },
    });
    expect(transfer.json().error.code).toBe('insufficient_funds');
  });

  it('eventos duplicados y fuera de orden de la red no duplican dinero', async () => {
    const c = await consumer();
    await fundVia(c, 40_000);
    const card = (
      await app.inject({
        method: 'POST',
        url: '/v1/personal/cards',
        headers: c.headers,
        payload: { currency: 'VES', form: 'virtual' },
      })
    ).json();
    const ref = `ext-${randomUUID()}`;
    const send = (event_id: string, event_type: string, payload: Record<string, unknown>) =>
      app.inject({
        method: 'POST',
        url: `/v1/programs/${program}/sandbox/provider-events`,
        headers: opOwner.headers,
        payload: { source: 'network', event_id, event_type, payload },
      });
    expect(
      (
        await send('cap-1', 'capture', { network_ref: ref, amount: '15000', capture_id: 'x1' })
      ).json().status
    ).toBe('unmatched');
    expect(
      (
        await send('auth-1', 'authorization.request', {
          card_id: card.id,
          amount: '15000',
          currency: 'VES',
          merchant_name: 'Farmacia externa',
          network_ref: ref,
        })
      ).json().status
    ).toBe('applied');
    expect(
      (
        await send('auth-1', 'authorization.request', {
          card_id: card.id,
          amount: '15000',
          currency: 'VES',
          merchant_name: 'Farmacia externa',
          network_ref: ref,
        })
      ).json().status
    ).toBe('duplicate');
    await stepUp(opOwner.headers);
    const resolved = await app.inject({
      method: 'POST',
      url: `/v1/programs/${program}/uncertain/resolve`,
      headers: opOwner.headers,
    });
    expect(resolved.json().events.applied).toBeGreaterThanOrEqual(1);
    const b = await balances(c);
    expect(b.available).toBe('25000');
    expect(b.held).toBe('0');
  });
});

describe('condiciones públicas del programa (presentación)', () => {
  it('sin sesión: devuelve los parámetros de la política ACTIVA, marcada como sintética', async () => {
    const r = await app.inject({ method: 'GET', url: `/v1/public/programs/${program}/terms` });
    expect(r.statusCode).toBe(200);
    const t = r.json();
    expect(t).toMatchObject({
      object: 'program_terms',
      sandbox: true,
      policy: {
        code: 'ref-sandbox',
        synthetic: true,
        installment_counts: [1, 3, 6],
        interval_days: 30,
        down_payment_bps: 2500,
        interest_bps: 0,
        late_fee_bps: 0,
      },
      cards: { max_live: 5 },
    });
    // Solo parámetros de producto: nada de ids, aprobadores ni clientes.
    const raw = JSON.stringify(t);
    expect(raw).not.toMatch(/approved_by|created_by|consumer|"id"/);
  });

  it('una organización que no es programa → 404', async () => {
    const r = await app.inject({ method: 'GET', url: `/v1/public/programs/${otherOrg}/terms` });
    expect(r.statusCode).toBe(404);
  });
});
