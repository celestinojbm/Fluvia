import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@fluvia/config';
import { createPool, type Pool } from '@fluvia/db';
import { AuthService } from '@fluvia/auth';
import { ApiKeyService, IdentityService } from '@fluvia/identity';
import { buildApp } from '../src/app.js';

/**
 * Jornada «ecosistema»: UNA compra vista por los tres usuarios.
 *
 * El cliente compra en una tienda Fluvia y paga con su tarjeta Fluvia; el
 * comercio la ve como pedido y cobro; Operaciones la sigue desde la
 * autorización del emisor. Las tres lecturas deben referirse al MISMO hecho
 * (`journey_ref` = id del pedido del comercio; mismo intent; misma
 * autorización) y a los mismos estados, leídos de sus fuentes canónicas:
 * intents/attempts/refunds del comercio y autorización del programa.
 *
 * Antes de esta jornada no existía ninguna lectura que uniera los dos lados:
 * Personal listaba la misma compra dos veces (pedido + compra con tarjeta) y
 * Operaciones no podía llegar desde la autorización al pedido.
 */

let app: FastifyInstance;
let appPool: Pool;
let authPool: Pool;
let adminPool: Pool;
let program: string;
let shopOrg: string;
let otherOrg: string;
let merchantId: string;
let slug: string;
const PASSWORD = 'jornada ecosistema 2026';
type Headers = Record<string, string>;
let opOwner: Headers;
let opStaff: Headers;
let shopOwner: Headers;
let otherOwner: Headers;
let productId: string;
const PRICE = 150_000;

const idem = () => ({ 'idempotency-key': `k-${randomUUID()}` });
const call = (
  h: Headers,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  url: string,
  payload?: Record<string, unknown>,
  extra: Headers = {}
) =>
  app.inject({
    method,
    url,
    headers: { ...h, ...extra },
    ...(payload !== undefined ? { payload } : {}),
  });

async function createOrg(name: string): Promise<string> {
  const res = await adminPool.query<{ id: string }>(
    'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id',
    [name, `org-${randomUUID()}`]
  );
  return res.rows[0]!.id;
}

async function sessionUser(role: string, orgId: string): Promise<Headers> {
  const email = `j-${randomUUID().slice(0, 12)}@example.com`;
  const reg = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email, password: PASSWORD },
  });
  await app.inject({
    method: 'POST',
    url: '/v1/auth/verify-email',
    payload: { token: reg.json().verification_token },
  });
  await adminPool.query('INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)', [
    orgId,
    reg.json().user_id,
    role,
  ]);
  const login = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email, password: PASSWORD },
  });
  return { authorization: `Bearer ${login.json().session_token as string}` };
}

async function consumer(): Promise<Headers> {
  const r = await app.inject({
    method: 'POST',
    url: `/v1/personal/programs/${program}/register`,
    payload: {
      email: `cli-${randomUUID().slice(0, 10)}@personal.fluvia.test`,
      password: 'clave del cliente 2026',
      display_name: 'Ana Ecosistema',
    },
  });
  expect(r.statusCode).toBe(201);
  return { authorization: `Bearer ${r.json().session as string}` };
}

async function fund(h: Headers, amount: number) {
  const f = await call(
    h,
    'POST',
    '/v1/personal/wallet/fundings',
    {
      amount: String(amount),
      currency: 'VES',
      method: 'mobile_payment',
    },
    idem()
  );
  const ev = await call(opOwner, 'POST', `/v1/programs/${program}/sandbox/provider-events`, {
    source: 'funding',
    event_type: 'funding.confirmed',
    payload: {
      provider_ref: f.json().funding.provider_ref,
      amount: String(amount),
      currency: 'VES',
    },
  });
  expect(ev.json().status).toBe('applied');
}

async function card(h: Headers): Promise<string> {
  const r = await call(
    h,
    'POST',
    '/v1/personal/cards',
    { currency: 'VES', form: 'virtual', funding_mode: 'wallet_only' },
    idem()
  );
  expect(r.statusCode).toBe(201);
  const c = r.json().card ?? r.json();
  if (c.status !== 'active') {
    await call(h, 'POST', `/v1/personal/cards/${c.id}/activate`, {}, idem());
  }
  return c.id as string;
}

/** Compra pagada con la tarjeta Fluvia (saldo). Devuelve el pedido. */
async function paidPurchase(h: Headers): Promise<{ orderId: string; cardId: string }> {
  await fund(h, 1_000_000);
  const cardId = await card(h);
  await call(h, 'POST', '/v1/personal/shop/cart/items', {
    slug,
    product_id: productId,
    quantity: 1,
  });
  const o = await call(
    h,
    'POST',
    '/v1/personal/shop/orders',
    { slug, currency: 'VES', expected_total: PRICE, fulfillment: 'pickup', share_contact: true },
    idem()
  );
  expect(o.statusCode).toBe(201);
  const orderId = o.json().order_id as string;
  const pay = await call(
    h,
    'POST',
    `/v1/personal/shop/orders/${orderId}/pay`,
    { card_id: cardId, mode: 'wallet' },
    idem()
  );
  expect(pay.json().outcome).toBe('approved');
  return { orderId, cardId };
}

beforeAll(async () => {
  const bootEnv = { NODE_ENV: 'test', LOG_LEVEL: 'error' };
  adminPool = createPool({ connectionString: loadConfig(bootEnv).db.admin, max: 2 });
  program = await createOrg('Fluvia Personal (ecosistema)');
  shopOrg = await createOrg('Librería Orinoco');
  otherOrg = await createOrg('Otro comercio');
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
    `INSERT INTO merchants (tenant_id, name, country, default_currency)
     VALUES ($1, 'Librería Orinoco', 'VE', 'VES') RETURNING id`,
    [shopOrg]
  );
  merchantId = m.rows[0]!.id;
  opOwner = await sessionUser('owner', program);
  opStaff = await sessionUser('staff', program);
  shopOwner = await sessionUser('owner', shopOrg);
  otherOwner = await sessionUser('owner', otherOrg);
  await call(opOwner, 'POST', '/v1/auth/step-up/password', { password: PASSWORD });
  const setup = await call(opOwner, 'POST', `/v1/programs/${program}/setup`, {
    name: 'Fluvia Personal',
    currencies: ['VES', 'USD'],
  });
  expect(setup.statusCode).toBe(201);

  slug = `orinoco-${randomUUID().slice(0, 6)}`;
  const prof = await call(
    shopOwner,
    'PUT',
    `/v1/organizations/${shopOrg}/directory/profiles/${merchantId}`,
    {
      slug,
      display_name: 'Librería Orinoco',
      category: 'papeleria',
      city: 'Ciudad Bolívar',
      summary: 'Libros usados y nuevos.',
      channels: ['online'],
      expected_version: 0,
    }
  );
  expect(prof.statusCode).toBeLessThan(300);
  const pub = await call(
    shopOwner,
    'POST',
    `/v1/organizations/${shopOrg}/directory/profiles/${merchantId}/publish`,
    { confirm_public: true, expected_version: prof.json().version }
  );
  expect(pub.statusCode).toBe(200);
  const p = await call(shopOwner, 'POST', `/v1/organizations/${shopOrg}/catalog/products`, {
    name: 'Atlas del Orinoco',
    price: PRICE,
    currency: 'VES',
  });
  expect(p.statusCode).toBe(201);
  productId = p.json().id;
  const s = await call(
    shopOwner,
    'PUT',
    `/v1/organizations/${shopOrg}/shop/merchants/${merchantId}`,
    {
      enabled: true,
      pickup: true,
      delivery: false,
      delivery_terms: null,
      returns_policy: 'Cambios en 7 días.',
      contact_email: null,
      contact_phone: null,
      banner_ref: null,
      expected_version: 0,
    }
  );
  expect(s.statusCode).toBe(200);
  const l = await call(
    shopOwner,
    'PUT',
    `/v1/organizations/${shopOrg}/shop/listings/${productId}`,
    {
      visible: true,
      featured: false,
      collection: null,
      position: 0,
    }
  );
  expect(l.statusCode).toBe(200);
}, 60_000);

afterAll(async () => {
  await app.close();
  await Promise.all([appPool.end(), authPool.end(), adminPool.end()]);
});

describe('una compra, tres superficies, un mismo hecho', () => {
  it('Personal, Comercio y Operaciones leen el mismo journey_ref, cobro y autorización', async () => {
    const c = await consumer();
    const { orderId } = await paidPurchase(c);

    const mine = await call(c, 'GET', `/v1/personal/journeys/${orderId}`);
    expect(mine.statusCode).toBe(200);
    const shop = await call(
      shopOwner,
      'GET',
      `/v1/organizations/${shopOrg}/orders/${orderId}/journey`
    );
    expect(shop.statusCode).toBe(200);
    const authId = mine.json().issuer.authorization_id as string;
    const ops = await call(opOwner, 'GET', `/v1/programs/${program}/journeys/${authId}`);
    expect(ops.statusCode).toBe(200);

    for (const view of [mine.json(), shop.json(), ops.json()]) {
      expect(view).toMatchObject({
        journey_ref: orderId,
        currency: 'VES',
        total: String(PRICE),
        payment: { outcome: 'approved', state: 'paid' },
        merchant: { name: 'Librería Orinoco' },
      });
      expect(view.payment.intent_id).toBe(mine.json().payment.intent_id);
      expect(view.uncertain).toEqual([]);
      expect(typeof view.verified_at).toBe('string');
    }
    // El lado emisor lo ven el cliente y Operaciones; el comercio NO ve el
    // reparto saldo/crédito del cliente.
    expect(ops.json().issuer).toMatchObject({
      authorization_id: authId,
      status: 'captured',
      wallet_amount: String(PRICE),
      credit_amount: '0',
    });
    expect(shop.json().issuer).toBeUndefined();
    expect(JSON.stringify(shop.json())).not.toMatch(/wallet_amount|credit_amount|consumer_id/);
    // Operaciones ve los asientos de ambos lados; cada uno con su clave canónica.
    const keys = (ops.json().ledger as Array<{ side: string; key: string }>).map(
      (x) => `${x.side}:${x.key.split(':')[0]}`
    );
    expect(keys).toEqual(expect.arrayContaining(['merchant:attempt', 'program:auth']));
    // La misma lectura por pedido llega al mismo caso.
    const byOrder = await call(opOwner, 'GET', `/v1/programs/${program}/journeys/${orderId}`);
    expect(byOrder.json().issuer.authorization_id).toBe(authId);
  });

  it('la compra con tarjeta enlazada a un pedido no se cuenta dos veces en Actividad', async () => {
    const c = await consumer();
    const { orderId } = await paidPurchase(c);
    const purchases = await call(c, 'GET', '/v1/personal/purchases');
    const linked = purchases
      .json()
      .data.filter((a: { journey_ref?: string }) => a.journey_ref === orderId);
    expect(linked).toHaveLength(1);
  });

  it('devolución parcial: las tres superficies la ven con el estado verificado y el saldo vuelve', async () => {
    const c = await consumer();
    const { orderId } = await paidPurchase(c);
    const before = await call(
      shopOwner,
      'GET',
      `/v1/organizations/${shopOrg}/orders/${orderId}/journey`
    );
    const intentId = before.json().payment.intent_id as string;
    const r = await call(
      shopOwner,
      'POST',
      `/v1/organizations/${shopOrg}/refunds`,
      { payment_intent_id: intentId, amount: '50000', reason: 'requested_by_customer' },
      idem()
    );
    expect(r.statusCode).toBe(201);

    const mine = (await call(c, 'GET', `/v1/personal/journeys/${orderId}`)).json();
    const shop = (
      await call(shopOwner, 'GET', `/v1/organizations/${shopOrg}/orders/${orderId}/journey`)
    ).json();
    const ops = (
      await call(opOwner, 'GET', `/v1/programs/${program}/journeys/${mine.issuer.authorization_id}`)
    ).json();
    for (const view of [mine, shop, ops]) {
      expect(view.payment).toMatchObject({
        outcome: 'partially_refunded',
        amount_refunded: '50000',
      });
      expect(view.refunds).toEqual([
        expect.objectContaining({ amount: '50000', status: 'succeeded' }),
      ]);
    }
    expect(mine.issuer).toMatchObject({ refunded: '50000' });
    const bal = await call(c, 'GET', '/v1/personal/wallet/balances');
    expect(bal.json().data.find((b: { currency: string }) => b.currency === 'VES').available).toBe(
      String(1_000_000 - PRICE + 50_000)
    );
  });

  it('aislamiento: otro cliente, otra organización y un rol sin permiso no leen el caso', async () => {
    const a = await consumer();
    const b = await consumer();
    const { orderId } = await paidPurchase(a);
    const authId = (await call(a, 'GET', `/v1/personal/journeys/${orderId}`)).json().issuer
      .authorization_id as string;

    expect((await call(b, 'GET', `/v1/personal/journeys/${orderId}`)).statusCode).toBe(404);
    expect((await call(b, 'GET', `/v1/personal/journeys/${authId}`)).statusCode).toBe(404);
    // Otra organización: ni por su propia ruta ni por la del comercio.
    expect(
      (await call(otherOwner, 'GET', `/v1/organizations/${otherOrg}/orders/${orderId}/journey`))
        .statusCode
    ).toBe(404);
    expect(
      (await call(otherOwner, 'GET', `/v1/organizations/${shopOrg}/orders/${orderId}/journey`))
        .statusCode
    ).toBe(404);
    // El comercio no entra en Operaciones; un mesero del programa tampoco.
    expect(
      (await call(shopOwner, 'GET', `/v1/programs/${program}/journeys/${authId}`)).statusCode
    ).toBe(404);
    expect(
      (await call(opStaff, 'GET', `/v1/programs/${program}/journeys/${authId}`)).statusCode
    ).toBe(403);
    // Operaciones desde una organización que no es el programa: nada.
    expect(
      (await call(shopOwner, 'GET', `/v1/programs/${shopOrg}/journeys/${authId}`)).statusCode
    ).toBe(404);
    // Sesión de comercio en el plano del cliente: 401.
    expect((await call(shopOwner, 'GET', `/v1/personal/journeys/${orderId}`)).statusCode).toBe(401);
  });
});
