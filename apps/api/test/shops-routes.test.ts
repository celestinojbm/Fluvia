import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@fluvia/config';
import { createPool, type Pool } from '@fluvia/db';
import { AuthService } from '@fluvia/auth';
import { ApiKeyService, IdentityService } from '@fluvia/identity';
import {
  MemoryStorage,
  SimulatedCallTransport,
  SimulatedConversationProvider,
  SimulatedSpeechToText,
  SimulatedTextToSpeech,
} from '@fluvia/assistant';
import { buildApp } from '../src/app.js';

/**
 * Tiendas Fluvia por HTTP contra PostgreSQL REAL: el comercio publica su
 * tienda y productos; un cliente de Fluvia Personal descubre, guarda
 * favoritos, arma el carrito, crea el pedido (idempotente) y paga con su
 * tarjeta Fluvia (saldo) o con el checkout alojado. Se prueban rechazo,
 * incierto, reintento sin doble cobro, regreso del checkout sin confirmación
 * y aislamiento entre clientes y organizaciones.
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
const PASSWORD = 'tiendas fluvia 2026';
type Headers = Record<string, string>;
let opOwner: Headers;
let shopOwner: Headers;
let otherOwner: Headers;
const products: Record<string, string> = {};

const idem = () => ({ 'idempotency-key': `k-${randomUUID()}` });

async function createOrg(name: string): Promise<string> {
  const res = await adminPool.query<{ id: string }>(
    'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id',
    [name, `org-${randomUUID()}`]
  );
  return res.rows[0]!.id;
}

async function sessionUser(role: string, orgId: string): Promise<Headers> {
  const email = `t-${randomUUID().slice(0, 12)}@example.com`;
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

async function consumer() {
  const email = `cli-${randomUUID().slice(0, 10)}@personal.fluvia.test`;
  const r = await app.inject({
    method: 'POST',
    url: `/v1/personal/programs/${program}/register`,
    payload: { email, password: 'clave del cliente 2026', display_name: 'Ana Tienda' },
  });
  expect(r.statusCode).toBe(201);
  return { email, headers: { authorization: `Bearer ${r.json().session as string}` } };
}

async function fund(h: Headers, amount: number) {
  const f = await app.inject({
    method: 'POST',
    url: '/v1/personal/wallet/fundings',
    headers: { ...h, ...idem() },
    payload: { amount: String(amount), currency: 'VES', method: 'mobile_payment' },
  });
  const ev = await app.inject({
    method: 'POST',
    url: `/v1/programs/${program}/sandbox/provider-events`,
    headers: opOwner,
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

async function card(h: Headers): Promise<string> {
  const r = await app.inject({
    method: 'POST',
    url: '/v1/personal/cards',
    headers: { ...h, ...idem() },
    payload: { currency: 'VES', form: 'virtual', funding_mode: 'wallet_only' },
  });
  expect(r.statusCode).toBe(201);
  const c = r.json().card ?? r.json();
  if (c.status !== 'active') {
    const a = await app.inject({
      method: 'POST',
      url: `/v1/personal/cards/${c.id}/activate`,
      headers: { ...h, ...idem() },
      payload: {},
    });
    expect(a.statusCode).toBeLessThan(300);
  }
  return c.id as string;
}

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

async function addAndOrder(h: Headers, productId: string, quantity: number, total: number) {
  const add = await call(h, 'POST', '/v1/personal/shop/cart/items', {
    slug,
    product_id: productId,
    quantity,
  });
  expect(add.statusCode).toBe(200);
  const o = await call(
    h,
    'POST',
    '/v1/personal/shop/orders',
    { slug, currency: 'VES', expected_total: total, fulfillment: 'pickup', share_contact: true },
    idem()
  );
  expect(o.statusCode).toBe(201);
  return o.json();
}

beforeAll(async () => {
  const bootEnv = { NODE_ENV: 'test', LOG_LEVEL: 'error' };
  adminPool = createPool({ connectionString: loadConfig(bootEnv).db.admin, max: 2 });
  program = await createOrg('Fluvia Personal (tiendas)');
  shopOrg = await createOrg('Casa Ávila');
  otherOrg = await createOrg('Otra tienda');
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
    assistant: {
      env: { ASSISTANT_MESSAGES_PER_DAY: '50' },
      storage: new MemoryStorage(),
      providers: {
        conversation: new SimulatedConversationProvider(0),
        stt: new SimulatedSpeechToText(),
        tts: new SimulatedTextToSpeech(),
        call: new SimulatedCallTransport(),
      },
    },
  });
  await app.ready();
  const m = await adminPool.query<{ id: string }>(
    // Tienda de Caracas: mercado VE (sin país, la tabla asume 'CO' y el saldo
    // Fluvia —programa VES/USD— no se ofrece en ese mercado).
    `INSERT INTO merchants (tenant_id, name, country, default_currency)
     VALUES ($1, 'Casa Ávila', 'VE', 'VES') RETURNING id`,
    [shopOrg]
  );
  merchantId = m.rows[0]!.id;
  opOwner = await sessionUser('owner', program);
  shopOwner = await sessionUser('owner', shopOrg);
  otherOwner = await sessionUser('owner', otherOrg);
  await call(opOwner, 'POST', '/v1/auth/step-up/password', { password: PASSWORD });
  const setup = await call(opOwner, 'POST', `/v1/programs/${program}/setup`, {
    name: 'Fluvia Personal',
    currencies: ['VES', 'USD'],
  });
  expect(setup.statusCode).toBe(201);

  // El comercio: perfil publicado + productos del catálogo existente.
  slug = `casa-avila-${randomUUID().slice(0, 6)}`;
  const prof = await call(
    shopOwner,
    'PUT',
    `/v1/organizations/${shopOrg}/directory/profiles/${merchantId}`,
    {
      slug,
      display_name: 'Casa Ávila',
      category: 'hogar',
      city: 'Caracas',
      summary: 'Cerámica y textiles hechos a mano.',
      channels: ['online'],
      expected_version: 0,
    }
  );
  expect(prof.statusCode).toBeLessThan(300);
  const pub = await call(
    shopOwner,
    'POST',
    `/v1/organizations/${shopOrg}/directory/profiles/${merchantId}/publish`,
    {
      confirm_public: true,
      expected_version: prof.json().version,
    }
  );
  expect(pub.statusCode).toBe(200);
  for (const [name, price] of [
    ['Taza de barro', 120000],
    ['Mantel de lino', 450000],
    ['Jarra (no publicada)', 90000],
  ] as const) {
    const r = await call(shopOwner, 'POST', `/v1/organizations/${shopOrg}/catalog/products`, {
      name,
      price,
      currency: 'VES',
    });
    expect(r.statusCode).toBe(201);
    products[name] = r.json().id;
  }
}, 60_000);

afterAll(async () => {
  await app.close();
  await Promise.all([appPool.end(), authPool.end(), adminPool.end()]);
});

describe('el comercio publica su tienda', () => {
  it('otra organización no ve ni toca la tienda; el comercio activa y publica productos', async () => {
    expect(
      (await call(otherOwner, 'GET', `/v1/organizations/${shopOrg}/shop/merchants/${merchantId}`))
        .statusCode
    ).toBe(404);
    const s = await call(
      shopOwner,
      'PUT',
      `/v1/organizations/${shopOrg}/shop/merchants/${merchantId}`,
      {
        enabled: true,
        pickup: true,
        delivery: true,
        delivery_terms: 'Entregas martes y viernes en Caracas.',
        returns_policy: 'Cambios en 7 días con el empaque original.',
        contact_email: 'hola@casa-avila.test',
        contact_phone: '+58 212 555 0101',
        banner_ref: null,
        expected_version: 0,
      }
    );
    expect(s.statusCode).toBe(200);
    for (const n of ['Taza de barro', 'Mantel de lino']) {
      const l = await call(
        shopOwner,
        'PUT',
        `/v1/organizations/${shopOrg}/shop/listings/${products[n]}`,
        {
          visible: true,
          featured: n === 'Mantel de lino',
          collection: 'Mesa',
          position: 0,
        }
      );
      expect(l.statusCode).toBe(200);
    }
    const view = await call(
      shopOwner,
      'GET',
      `/v1/organizations/${shopOrg}/shop/merchants/${merchantId}`
    );
    expect(view.json().listings.filter((x: { listed: boolean }) => x.listed)).toHaveLength(2);
  });
});

describe('cliente: descubrir, favoritos, carrito, pedido, pago', () => {
  it('descubre solo lo publicado y sin datos internos', async () => {
    const c = await consumer();
    const list = await call(c.headers, 'GET', '/v1/personal/shop/stores?q=avila');
    const mine = list.json().data.find((s: { slug: string }) => s.slug === slug);
    expect(mine).toMatchObject({
      name: 'Casa Ávila',
      pickup: true,
      delivery: true,
      product_count: 2,
    });
    const shop = await call(c.headers, 'GET', `/v1/personal/shop/stores/${slug}`);
    const names = shop.json().products.map((p: { name: string }) => p.name);
    expect(names).toEqual(['Mantel de lino', 'Taza de barro']);
    expect(JSON.stringify(shop.json())).not.toMatch(
      new RegExp(`${shopOrg}|${merchantId}|on_hand|reserved`)
    );
    const search = await call(c.headers, 'GET', '/v1/personal/shop/search?q=LINO');
    const here = search
      .json()
      .data.filter((p: { shop_slug: string }) => p.shop_slug === slug)
      .map((p: { name: string }) => p.name);
    expect(here).toEqual(['Mantel de lino']);
    // Sin sesión de cliente no hay tiendas (plano autenticado).
    expect((await app.inject({ method: 'GET', url: '/v1/personal/shop/stores' })).statusCode).toBe(
      401
    );
  });

  it('favoritos persistentes por cliente', async () => {
    const c = await consumer();
    await call(c.headers, 'POST', '/v1/personal/shop/favorites', { slug, favorite: true });
    const fav = await call(c.headers, 'GET', '/v1/personal/shop/stores?favorites=1');
    expect(fav.json().data.map((s: { slug: string }) => s.slug)).toEqual([slug]);
    const other = await consumer();
    expect(
      (await call(other.headers, 'GET', '/v1/personal/shop/stores?favorites=1')).json().data
    ).toEqual([]);
  });

  it('compra completa con la tarjeta Fluvia (saldo): aprobado, sin doble cobro al reintentar', async () => {
    const c = await consumer();
    await fund(c.headers, 1_000_000);
    const cardId = await card(c.headers);
    const order = await addAndOrder(c.headers, products['Taza de barro']!, 2, 240000);
    expect(order).toMatchObject({
      total: '240000',
      outcome: 'unpaid',
      fulfillment_status: 'received',
    });
    expect(order.lines[0]).toMatchObject({
      name: 'Taza de barro',
      unit_price: '120000',
      quantity: 2,
    });
    expect(order.payment_link_id).toBeUndefined();

    const pay = () =>
      call(
        c.headers,
        'POST',
        `/v1/personal/shop/orders/${order.order_id}/pay`,
        { card_id: cardId, mode: 'wallet' },
        idem()
      );
    const first = await pay();
    expect(first.statusCode).toBe(200);
    expect(first.json().outcome).toBe('approved');
    // Reintento (otra clave, mismo pedido): devuelve el estado sin cobrar de nuevo.
    const again = await pay();
    expect(again.json().outcome).toBe('approved');
    const charges = await adminPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM payment_intents i JOIN commerce_orders o ON o.payment_link_id = i.payment_link_id
        WHERE o.id = $1 AND i.status = 'succeeded'`,
      [order.order_id]
    );
    expect(charges.rows[0]!.n).toBe(1);
    const bal = await call(c.headers, 'GET', '/v1/personal/wallet/balances');
    expect(bal.json().data.find((b: { currency: string }) => b.currency === 'VES').available).toBe(
      '760000'
    );

    // El comercio ve el pedido en línea y avanza la entrega.
    const admin = await call(shopOwner, 'GET', `/v1/organizations/${shopOrg}/shop/orders`);
    const row = admin.json().data.find((o: { order_id: string }) => o.order_id === order.order_id);
    expect(row).toMatchObject({
      payment_state: 'paid',
      buyer_name: 'Ana Tienda',
      fulfillment: 'pickup',
    });
    const step = await call(
      shopOwner,
      'POST',
      `/v1/organizations/${shopOrg}/shop/orders/${order.order_id}/fulfillment`,
      {
        status: 'ready',
      }
    );
    expect(step.json().fulfillment_status).toBe('ready');
    const track = await call(c.headers, 'GET', `/v1/personal/shop/orders/${order.order_id}`);
    expect(track.json()).toMatchObject({ outcome: 'approved', fulfillment_status: 'ready' });
    // Devolución: queda registrada para el comercio (reembolso por el flujo existente).
    const ret = await call(c.headers, 'POST', `/v1/personal/shop/orders/${order.order_id}/return`, {
      reason: 'Una taza llegó despostillada',
    });
    expect(ret.json().return_reason).toBe('Una taza llegó despostillada');
  });

  it('saldo insuficiente ⇒ rechazado; el pedido sigue pendiente y se puede pagar después', async () => {
    const c = await consumer();
    await fund(c.headers, 100_000);
    const cardId = await card(c.headers);
    const order = await addAndOrder(c.headers, products['Mantel de lino']!, 1, 450000);
    const r = await call(
      c.headers,
      'POST',
      `/v1/personal/shop/orders/${order.order_id}/pay`,
      { card_id: cardId, mode: 'wallet' },
      idem()
    );
    expect(r.json().outcome).toBe('declined');
    expect(r.json().payment.state).toBe('awaiting_payment');
    await fund(c.headers, 500_000);
    const ok = await call(
      c.headers,
      'POST',
      `/v1/personal/shop/orders/${order.order_id}/pay`,
      { card_id: cardId, mode: 'wallet' },
      idem()
    );
    expect(ok.json().outcome).toBe('approved');
  });

  it('otra tarjeta (checkout alojado): volver sin confirmar NO marca pagado; incierto queda «en confirmación»', async () => {
    const c = await consumer();
    const order = await addAndOrder(c.headers, products['Taza de barro']!, 1, 120000);
    const co = await call(c.headers, 'POST', `/v1/personal/shop/orders/${order.order_id}/checkout`);
    expect(co.statusCode).toBe(200);
    const url = new URL(co.json().url as string);
    expect(url.pathname).toMatch(/^\/l\/[0-9a-f-]{36}$/);
    // El checkout alojado (público) abre su sesión con el secreto.
    const ses = await app.inject({
      method: 'POST',
      url: `/v1/payment_links${url.pathname.slice(2)}/sessions`,
    });
    expect(ses.statusCode).toBe(200);
    const sessionId = ses.json().checkout_session_id as string;
    const secret = ses.json().client_secret as string;
    // El cliente «vuelve» sin haber pagado: sigue pendiente.
    let t = await call(c.headers, 'GET', `/v1/personal/shop/orders/${order.order_id}`);
    expect(t.json().outcome).toBe('unpaid');
    // Desenlace desconocido del proveedor.
    await app.inject({
      method: 'POST',
      url: `/v1/checkout_sessions/${sessionId}/confirm`,
      headers: { 'x-checkout-client-secret': secret },
      payload: { payment_method_token: 'tok_timeout' },
    });
    t = await call(c.headers, 'GET', `/v1/personal/shop/orders/${order.order_id}`);
    expect(t.json().outcome).toBe('pending');
    // Con un cobro en confirmación, el cliente no puede anular ni volver a pagar.
    expect(
      (await call(c.headers, 'POST', `/v1/personal/shop/orders/${order.order_id}/cancel`))
        .statusCode
    ).toBe(409);
  });

  it('pedido idempotente por Idempotency-Key; precio cambiado ⇒ 409 antes de pagar', async () => {
    const c = await consumer();
    await call(c.headers, 'POST', '/v1/personal/shop/cart/items', {
      slug,
      product_id: products['Taza de barro'],
      quantity: 1,
    });
    const key = idem();
    const body = {
      slug,
      currency: 'VES',
      expected_total: 120000,
      fulfillment: 'pickup',
      share_contact: true,
    };
    const [a, b] = await Promise.all([
      call(c.headers, 'POST', '/v1/personal/shop/orders', body, key),
      call(c.headers, 'POST', '/v1/personal/shop/orders', body, key),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201]);
    expect(a.json().order_id).toBe(b.json().order_id);

    await call(c.headers, 'POST', '/v1/personal/shop/cart/items', {
      slug,
      product_id: products['Mantel de lino'],
      quantity: 1,
    });
    const v = await adminPool.query<{ version: number }>(
      `SELECT version FROM catalog_products WHERE id = $1`,
      [products['Mantel de lino']]
    );
    await call(
      shopOwner,
      'PATCH',
      `/v1/organizations/${shopOrg}/catalog/products/${products['Mantel de lino']}`,
      {
        price: 480000,
        expected_version: v.rows[0]!.version,
      }
    );
    const cart = await call(c.headers, 'GET', '/v1/personal/shop/cart');
    expect(cart.json().data[0].lines[0].status).toBe('price_changed');
    const stale = await call(
      c.headers,
      'POST',
      '/v1/personal/shop/orders',
      { ...body, expected_total: 450000 },
      idem()
    );
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('order_total_changed');
    // Restaurar el precio para los demás escenarios.
    const v2 = await adminPool.query<{ version: number }>(
      `SELECT version FROM catalog_products WHERE id = $1`,
      [products['Mantel de lino']]
    );
    await call(
      shopOwner,
      'PATCH',
      `/v1/organizations/${shopOrg}/catalog/products/${products['Mantel de lino']}`,
      {
        price: 450000,
        expected_version: v2.rows[0]!.version,
      }
    );
  });

  it('aislamiento: un cliente no ve ni paga el pedido de otro; un producto no publicado no se compra', async () => {
    const a = await consumer();
    const b = await consumer();
    const order = await addAndOrder(a.headers, products['Taza de barro']!, 1, 120000);
    for (const [m, path] of [
      ['GET', ''],
      ['POST', '/cancel'],
      ['POST', '/checkout'],
    ] as const) {
      expect(
        (await call(b.headers, m, `/v1/personal/shop/orders/${order.order_id}${path}`)).statusCode
      ).toBe(404);
    }
    const unlisted = await call(a.headers, 'POST', '/v1/personal/shop/cart/items', {
      slug,
      product_id: products['Jarra (no publicada)'],
      quantity: 1,
    });
    expect(unlisted.statusCode).toBe(404);
    // Una sesión de COMERCIO no abre el plano del cliente.
    expect((await call(shopOwner, 'GET', '/v1/personal/shop/cart')).statusCode).toBe(401);
  });
});

describe('asistente en Tiendas (solo lectura, datos propios)', () => {
  const A = '/v1/personal/assistant';
  const sse = (body: string) =>
    body
      .split('\n\n')
      .filter((b) => b.trim())
      .map((b) => ({
        event: /event: (.+)/.exec(b)?.[1] ?? '',
        data: JSON.parse(/data: (.+)/.exec(b)?.[1] ?? '{}') as Record<string, unknown>,
      }));
  async function ask(h: Headers, text: string, route: string) {
    const conv = await call(h, 'POST', `${A}/conversations`, {});
    expect(conv.statusCode).toBe(201);
    const r = await call(h, 'POST', `${A}/conversations/${conv.json().id}/messages`, {
      text,
      context: { route },
    });
    expect(r.statusCode).toBe(200);
    const evs = sse(r.body);
    return evs.find((e) => e.event === 'done')!.data.message as {
      content: string;
      tools_used: string[];
      actions: Array<{ href: string }>;
    };
  }

  it('busca productos publicados, lee SU carrito y SUS pedidos; no compra', async () => {
    const a = await consumer();
    const b = await consumer();
    await fund(a.headers, 500_000);
    const cardId = await card(a.headers);
    // Precio vigente leído del servidor (otras pruebas del archivo lo cambian).
    const pdp = await call(
      a.headers,
      'GET',
      `/v1/personal/shop/stores/${slug}/products/${products['Taza de barro']}`
    );
    const price = Number(pdp.json().product.price);
    const orderId = (await addAndOrder(a.headers, products['Taza de barro']!, 1, price))
      .order_id as string;
    const pay = await call(
      a.headers,
      'POST',
      `/v1/personal/shop/orders/${orderId}/pay`,
      { card_id: cardId, mode: 'wallet' },
      idem()
    );
    expect(pay.statusCode).toBe(200);
    await call(b.headers, 'POST', '/v1/personal/shop/cart/items', {
      slug,
      product_id: products['Taza de barro'],
      quantity: 2,
    });

    const found = await ask(a.headers, 'busca una taza', `/personal/tiendas/${slug}`);
    expect(found.tools_used).toEqual(['search_shop_products']);
    expect(found.content).toMatch(/Taza/);
    expect(found.content).not.toMatch(/on_hand|reservad|tenant/i);

    const mine = await ask(a.headers, '¿cómo va mi pedido?', '/personal/actividad');
    expect(mine.tools_used).toEqual(['list_my_shop_orders']);
    expect(mine.content).toMatch(/pagado/);

    // El carrito de B no aparece en el de A (y viceversa).
    const cartA = await ask(a.headers, '¿qué tengo en el carrito?', '/personal/carrito');
    expect(cartA.tools_used).toEqual(['get_my_cart']);
    expect(cartA.content).toMatch(/vacío/);
    const cartB = await ask(b.headers, '¿qué tengo en el carrito?', '/personal/carrito');
    expect(cartB.content).toMatch(/1 línea/);
    const ordersB = await ask(b.headers, 'mis pedidos', '/personal/actividad');
    expect(ordersB.content).toMatch(/Aún no tienes pedidos/);

    // Pedir que compre: se niega y lleva a la pantalla; no crea pedido.
    const before = await call(b.headers, 'GET', '/v1/personal/shop/orders');
    const refuse = await ask(b.headers, 'cómpralo por mí', `/personal/tiendas/${slug}`);
    expect(refuse.tools_used).toEqual([]);
    expect(refuse.content).toMatch(/No puedo hacer operaciones/);
    expect(refuse.actions.map((x) => x.href)).toContain('/personal/carrito');
    const after = await call(b.headers, 'GET', '/v1/personal/shop/orders');
    expect(after.json().data).toHaveLength(before.json().data.length);
  });
});
