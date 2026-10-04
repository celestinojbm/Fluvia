#!/usr/bin/env node
/* global process, fetch, console */
/* eslint-disable no-console -- herramienta de línea de órdenes: imprime JSON */
/**
 * Datos de captura del ecosistema contra la API REAL de una instancia de demo
 * (sin navegador): con la clienta de la demo crea en «Casa Ávila» un pedido
 * SIN pagar y otro PAGADO con su tarjeta Fluvia (saldo). Imprime JSON con los
 * ids para que las capturas «antes» y «después» usen los mismos casos.
 *
 *   API_URL                 API de la instancia (p. ej. http://127.0.0.1:3340)
 *   FLUVIA_PROGRAM_TENANT_ID organización programa de la demo
 *   SHOP_SLUG               por defecto casa-avila
 *
 * Solo sandbox: credenciales sintéticas de la semilla de demo.
 */
const API = process.env.API_URL ?? 'http://127.0.0.1:3340';
const PROGRAM = process.env.FLUVIA_PROGRAM_TENANT_ID ?? 'e744e6eb-95cf-5762-95a7-268a0917e747';
const SLUG = process.env.SHOP_SLUG ?? 'casa-avila';
const key = () => `cap-${Date.now()}-${Math.random().toString(16).slice(2)}`;

async function call(token, method, path, body, extra = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...extra,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
  return json;
}

const login = await call(null, 'POST', `/v1/personal/programs/${PROGRAM}/login`, {
  email: 'cliente@demo.fluvia.test',
  password: 'demo-cliente-password',
});
const t = login.session;
const shop = await call(t, 'GET', `/v1/personal/shop/stores/${SLUG}`);
const products = shop.products.filter((p) => p.sellable && p.in_stock && p.currency === 'VES');
const cards = await call(t, 'GET', '/v1/personal/cards');
const card = (cards.data ?? cards).find((c) => c.status === 'active' && c.currency === 'VES');

async function order(product) {
  await call(t, 'POST', '/v1/personal/shop/cart/items', {
    slug: SLUG,
    product_id: product.id,
    quantity: 1,
  });
  const o = await call(
    t,
    'POST',
    '/v1/personal/shop/orders',
    {
      slug: SLUG,
      currency: 'VES',
      expected_total: Number(product.price),
      fulfillment: 'pickup',
      share_contact: true,
    },
    { 'idempotency-key': key() }
  );
  return o.order_id;
}

const unpaid = await order(products[0]);
const paid = await order(products[1] ?? products[0]);
const pay = await call(
  t,
  'POST',
  `/v1/personal/shop/orders/${paid}/pay`,
  { card_id: card.id, mode: 'wallet' },
  { 'idempotency-key': key() }
);
const journey = await call(t, 'GET', `/v1/personal/journeys/${paid}`).catch(() => null);
console.log(
  JSON.stringify({
    unpaid,
    paid,
    paidOutcome: pay.outcome,
    authorization: journey?.issuer?.authorization_id ?? null,
  })
);
