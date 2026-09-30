/* global process, URL, setTimeout */
// API SINTÉTICA para el E2E de navegador del justificante (CI y local).
// Implementa SOLO los GET del plano de sesión que leen el POS y el
// justificante, con la MISMA forma que los serializers reales de apps/api
// (publicIntent, publicRefund, publicSession, publicSale, merchants). Todos
// los datos son inventados. No es la fuente de verdad: la verificación contra
// el stack real está en e2e/real-stack/.
//
// Control (solo para el test): GET /__mode?receipt=ok|fail|auth
import http from 'node:http';

const PORT = Number(process.env.SYNTHETIC_API_PORT ?? 3999);
export const ORG = 'aaaaaaaa-0000-4000-8000-00000000a001';
const MER = 'bbbbbbbb-0000-4000-8000-00000000b001';
const u = (p, n) => `${p}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const pi = (n) => u('cccccccc', n);
const cs = (n) => u('dddddddd', n);
const rf = (n) => u('eeeeeeee', n);
const LINK = u('ffffffff', 1);
const T = (h, m = 0, s = 0) =>
  `2026-09-30T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}Z`;

// 1 confirmado (venta + concepto) · 2 parcial (+ una cancelada) · 3 total
// 4 incierta · 5 en curso · 6 rechazado (sin justificante)
// 7 más de 100 devoluciones: la más ANTIGUA es `indeterminate` y queda FUERA
//   de la ventana de 100 que devuelve la API (ORDER BY created_at DESC).
const intents = {
  [pi(1)]: {
    amount: 4550,
    captured: 4550,
    refunded: 0,
    status: 'succeeded',
    link: LINK,
    at: T(9, 5),
  },
  [pi(2)]: {
    amount: 12000,
    captured: 12000,
    refunded: 3000,
    status: 'partially_refunded',
    link: null,
    at: T(10, 12),
  },
  [pi(3)]: {
    amount: 2500,
    captured: 2500,
    refunded: 2500,
    status: 'refunded',
    link: null,
    at: T(11, 30),
  },
  [pi(4)]: {
    amount: 8000,
    captured: 8000,
    refunded: 0,
    status: 'succeeded',
    link: null,
    at: T(12, 45),
  },
  [pi(5)]: {
    amount: 6000,
    captured: 6000,
    refunded: 0,
    status: 'succeeded',
    link: null,
    at: T(13, 10),
  },
  [pi(6)]: { amount: 3000, captured: 0, refunded: 0, status: 'failed', link: null, at: T(13, 40) },
  [pi(7)]: {
    amount: 90000,
    captured: 90000,
    refunded: 1000,
    status: 'partially_refunded',
    link: null,
    at: T(7, 0),
  },
};
const refunds = {
  [pi(2)]: [
    { id: rf(1), amount: 3000, status: 'succeeded', at: T(10, 40), reason: 'NOTA INTERNA' },
    { id: rf(2), amount: 1500, status: 'canceled', at: T(10, 50), reason: 'NOTA INTERNA' },
  ],
  [pi(3)]: [{ id: rf(3), amount: 2500, status: 'succeeded', at: T(11, 55), reason: null }],
  [pi(4)]: [
    { id: rf(4), amount: 8000, status: 'indeterminate', at: T(13, 0), reason: 'NOTA INTERNA' },
  ],
  [pi(5)]: [{ id: rf(5), amount: 2000, status: 'processing', at: T(13, 20), reason: null }],
  [pi(7)]: [
    { id: rf(700), amount: 5000, status: 'indeterminate', at: T(7, 10), reason: null },
    ...Array.from({ length: 100 }, (_, i) => ({
      id: rf(701 + i),
      amount: 10,
      status: 'succeeded',
      at: T(8, Math.floor(i / 60), i % 60),
      reason: null,
    })),
  ],
};

const publicIntent = (id) => {
  const i = intents[id];
  return {
    id,
    object: 'payment_intent',
    merchant_id: MER,
    amount: i.amount,
    currency: 'USD',
    status: i.status,
    capture_method: 'automatic',
    amount_captured: i.captured,
    amount_refunded: i.refunded,
    failure_code: i.status === 'failed' ? 'card_declined' : null,
    payment_link_id: i.link,
    created_at: i.at,
  };
};
const n = (id) => Number(id.slice(-2));
const publicSession = (id) => {
  const i = intents[id];
  const k = n(id);
  return {
    id: cs(k),
    object: 'checkout_session',
    payment_intent_id: id,
    customer_id: null,
    status: i.status === 'failed' ? 'open' : 'completed',
    url: `http://checkout.invalid/c/${cs(k)}`,
    success_url: null,
    cancel_url: null,
    expires_at: T(23, 0),
    completed_at: i.status === 'failed' ? null : i.at.replace(/:00Z$/, ':40Z'),
    created_at: i.at,
  };
};

let mode = 'ok';
const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const merchant = {
  id: MER,
  name: 'Tienda Sintética Centro',
  country: 'CO',
  defaultCurrency: 'USD',
  status: 'active',
  createdAt: T(8),
};

http
  .createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname;
    if (p === '/__mode') {
      mode = url.searchParams.get('receipt') ?? 'ok';
      return send(res, 200, { mode });
    }
    if (p === '/health') return send(res, 200, { status: 'ok' });
    if (p === '/v1/organizations')
      return send(res, 200, {
        organizations: [
          {
            organization_id: ORG,
            name: 'Cafetería Sintética',
            slug: 'cafeteria-sintetica',
            role: 'owner',
          },
        ],
      });
    const base = `/v1/organizations/${ORG}`;
    if (!p.startsWith(base)) return send(res, 404, {});
    const r = p.slice(base.length);
    const receiptRead = /^\/(payment_intents\/|refunds$|merchants\/)/.test(r);
    if (receiptRead && mode === 'fail') return send(res, 503, {});
    if (receiptRead && mode === 'auth') return send(res, 401, {});
    if (receiptRead && mode === 'slow') await new Promise((ok) => setTimeout(ok, 30_000));

    if (r === '/merchants') return send(res, 200, { merchants: [merchant] });
    if (r === `/merchants/${MER}`) return send(res, 200, merchant);
    if (r === '/payment_intents')
      return send(res, 200, { object: 'list', data: Object.keys(intents).map(publicIntent) });
    if (r === '/checkout_sessions')
      return send(res, 200, { object: 'list', data: Object.keys(intents).map(publicSession) });
    let m = /^\/payment_intents\/([0-9a-f-]{36})$/.exec(r);
    if (m) return intents[m[1]] ? send(res, 200, publicIntent(m[1])) : send(res, 404, {});
    m = /^\/checkout_sessions\/([0-9a-f-]{36})$/.exec(r);
    if (m) {
      const id = Object.keys(intents).find((k) => cs(n(k)) === m[1]);
      return id ? send(res, 200, publicSession(id)) : send(res, 404, {});
    }
    if (r === '/refunds') {
      const id = url.searchParams.get('payment_intent_id');
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 20), 100);
      // Como RefundService.list: ORDER BY created_at DESC LIMIT n.
      const data = [...(refunds[id] ?? [])]
        .sort((a, b) => b.at.localeCompare(a.at))
        .slice(0, limit)
        .map((x) => ({
          id: x.id,
          object: 'refund',
          payment_intent_id: id,
          amount: x.amount,
          currency: 'USD',
          status: x.status,
          reason: x.reason,
          failure_code: x.status === 'canceled' ? 'insufficient_merchant_balance' : null,
          created_at: x.at,
        }));
      return send(res, 200, { object: 'list', data });
    }
    if (r === `/payment_links/${LINK}/sale`)
      return send(res, 200, {
        object: 'payment_link_sale',
        payment_link: {
          id: LINK,
          object: 'payment_link',
          merchant_id: MER,
          amount: 4550,
          currency: 'USD',
          description: 'Desayuno para dos (sintético)',
          status: 'active',
          url: `http://checkout.invalid/l/${LINK}`,
          metadata: {},
          single_charge: true,
          checkout_tracking_since: T(0),
          created_at: T(9),
          disabled_at: null,
        },
        charge: 'charged',
        charge_payment_intent_id: pi(1),
        succeeded_count: 1,
        history: 'complete',
        truncated: false,
        checkouts: [
          {
            payment_intent_id: pi(1),
            payment_intent_status: 'succeeded',
            failure_code: null,
            amount_refunded: 0,
            created_at: T(9, 5),
            checkout_session: {
              id: cs(1),
              status: 'completed',
              expires_at: T(23),
              completed_at: T(9, 6),
              created_at: T(9, 5),
            },
          },
        ],
      });
    return send(res, 404, {});
  })
  .listen(PORT, '127.0.0.1');
