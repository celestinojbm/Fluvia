import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../app/lib/csrf-header';
import { GET as refundsGET } from '../app/api/orgs/[orgId]/pos/payments/[paymentId]/refunds/route';
import { POST as refundPOST } from '../app/api/orgs/[orgId]/refunds/route';
import {
  isRefundableStatus,
  pickRefund,
  pickRefundList,
  summarizeRefunds,
} from '../app/lib/pos-refund-contract';

/**
 * Devolución del POS — contrato puro + BFF. Lectura por whitelist TODO o NADA
 * (un refund ajeno o malformado invalida la lista), cupo conservador, y la
 * creación ahora detrás del guard CSRF same-origin.
 */

const cookieState = vi.hoisted(() => ({ value: 'session-token-test' as string | null }));
vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) =>
        name === 'fluvia_session' && cookieState.value !== null
          ? { value: cookieState.value }
          : undefined,
    }),
}));

const ORG = '1bfed2e0-1de8-52d5-9352-0cfd7e27a5e1';
const PI = '57621b57-547b-4742-8f51-345696d4b3d2';
const OTHER_PI = '6f0c7a1e-2b1d-4c3e-9f8a-1a2b3c4d5e6f';
const RF = '0b8e7c6d-5a4b-4c3d-8e2f-1a0b9c8d7e6f';
const BASE = 'http://dashboard.local';
const API = 'http://127.0.0.1:3000';

const refund = (over: Record<string, unknown> = {}) => ({
  id: RF,
  object: 'refund',
  payment_intent_id: PI,
  amount: 500,
  currency: 'USD',
  status: 'succeeded',
  reason: null,
  failure_code: null,
  created_at: '2026-09-30T10:00:00Z',
  ...over,
});

const json = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

beforeEach(() => {
  cookieState.value = 'session-token-test';
  vi.stubEnv('FLUVIA_DASHBOARD_ORIGIN', BASE);
  vi.stubEnv('FLUVIA_API_URL', API);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('contrato de devoluciones', () => {
  it('pickRefund reconstruye por whitelist y rechaza estados o importes inválidos', () => {
    const r = pickRefund({ ...refund(), provider_ref: 'mockr_x', secret: 'nope' });
    expect(r).toEqual({
      id: RF,
      payment_intent_id: PI,
      amount: 500,
      currency: 'USD',
      status: 'succeeded',
      reason: null,
      failure_code: null,
      created_at: '2026-09-30T10:00:00Z',
    });
    expect(pickRefund(refund({ status: 'weird' }))).toBeNull();
    expect(pickRefund(refund({ amount: 0 }))).toBeNull();
    expect(pickRefund(refund({ amount: 1.5 }))).toBeNull();
    expect(pickRefund(refund({ id: 'x' }))).toBeNull();
  });

  it('pickRefundList es todo o nada: un refund de OTRO intent invalida la lectura', () => {
    expect(pickRefundList({ data: [refund()] }, PI)?.refunds).toHaveLength(1);
    expect(
      pickRefundList({ data: [refund(), refund({ payment_intent_id: OTHER_PI })] }, PI)
    ).toBeNull();
    expect(pickRefundList({ data: [refund(), { id: 'broken' }] }, PI)).toBeNull();
    expect(pickRefundList({ nope: [] }, PI)).toBeNull();
  });

  it('una ventana llena (100) se marca truncada', () => {
    const many = Array.from({ length: 100 }, (_, i) =>
      refund({ id: `0b8e7c6d-5a4b-4c3d-8e2f-${String(i).padStart(12, '0')}` })
    );
    expect(pickRefundList({ data: many }, PI)?.truncated).toBe(true);
    expect(pickRefundList({ data: [refund()] }, PI)?.truncated).toBe(false);
  });

  it('el cupo es conservador: descuenta en curso E indeterminadas; fallidas no', () => {
    const list = [
      pickRefund(refund({ status: 'succeeded', amount: 200 }))!,
      pickRefund(refund({ status: 'indeterminate', amount: 300 }))!,
      pickRefund(refund({ status: 'processing', amount: 100 }))!,
      pickRefund(refund({ status: 'failed', amount: 900 }))!,
      pickRefund(refund({ status: 'canceled', amount: 900 }))!,
    ];
    const s = summarizeRefunds({ amount_captured: 1250, amount_refunded: 200 }, list);
    expect(s).toEqual({
      captured: 1250,
      refunded: 200,
      pending: 400,
      remaining: 650,
      open: true,
      uncertain: true,
    });
    expect(summarizeRefunds({ amount_captured: 100, amount_refunded: 100 }, []).remaining).toBe(0);
  });

  it('solo succeeded y partially_refunded admiten devolución', () => {
    expect(isRefundableStatus('succeeded')).toBe(true);
    expect(isRefundableStatus('partially_refunded')).toBe(true);
    for (const s of ['refunded', 'processing', 'failed', 'canceled', 'authorized']) {
      expect(isRefundableStatus(s)).toBe(false);
    }
  });
});

describe('GET /api/orgs/:orgId/pos/payments/:paymentId/refunds', () => {
  const ctx = { params: Promise.resolve({ orgId: ORG, paymentId: PI }) };
  const req = () => new Request(`${BASE}/api/orgs/${ORG}/pos/payments/${PI}/refunds`);
  const path = `${API}/v1/organizations/${ORG}/refunds?payment_intent_id=${PI}&limit=100`;

  it('lee por sesión con el filtro del intent y responde por whitelist', async () => {
    const f = vi.fn((url: string, _init?: RequestInit) => {
      expect(url).toBe(path);
      return json(200, { object: 'list', data: [refund({ provider_ref: 'x' })] });
    });
    vi.stubGlobal('fetch', f);
    const res = await refundsGET(req(), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.truncated).toBe(false);
    expect(body.refunds[0]).not.toHaveProperty('provider_ref');
    const init = f.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe(
      'Bearer session-token-test'
    );
  });

  it('distingue sesión caducada, sin acceso y fallo de lectura', async () => {
    for (const [upstream, status, code] of [
      [401, 401, 'invalid_session'],
      [403, 404, 'not_found'],
      [404, 404, 'not_found'],
      [500, 502, 'upstream_unavailable'],
    ] as const) {
      vi.stubGlobal(
        'fetch',
        vi.fn(() => json(upstream, { error: { code: 'x' } }))
      );
      const res = await refundsGET(req(), ctx);
      expect(res.status, String(upstream)).toBe(status);
      expect((await res.json()).error.code).toBe(code);
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('down')))
    );
    expect((await refundsGET(req(), ctx)).status).toBe(502);
    // Un refund de otro intent en la respuesta ⇒ 502, jamás una lista parcial.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => json(200, { data: [refund({ payment_intent_id: OTHER_PI })] }))
    );
    expect((await refundsGET(req(), ctx)).status).toBe(502);
  });

  it('sin cookie ⇒ 401 sin tocar el backend; ids inválidos ⇒ 400', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    cookieState.value = null;
    expect((await refundsGET(req(), ctx)).status).toBe(401);
    cookieState.value = 'session-token-test';
    const bad = { params: Promise.resolve({ orgId: ORG, paymentId: 'nope' }) };
    expect((await refundsGET(req(), bad)).status).toBe(400);
    expect(f).not.toHaveBeenCalled();
  });
});

describe('POST /api/orgs/:orgId/refunds (guard CSRF)', () => {
  const ctx = { params: Promise.resolve({ orgId: ORG }) };
  const req = (headers: Record<string, string>) =>
    new Request(`${BASE}/api/orgs/${ORG}/refunds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'k-1', ...headers },
      body: JSON.stringify({ payment_intent_id: PI, amount: 500 }),
    });
  const legit = { origin: BASE, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE };

  it('rechaza cross-site, same-site y sin header CSRF SIN tocar el backend', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    for (const h of <Array<Record<string, string>>>[
      { origin: 'https://evil.test', 'sec-fetch-site': 'cross-site', [CSRF_HEADER]: '1' },
      { origin: 'http://sub.dashboard.local', 'sec-fetch-site': 'same-site', [CSRF_HEADER]: '1' },
      { origin: BASE, 'sec-fetch-site': 'same-origin' },
      { 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: '1' },
    ]) {
      const res = await refundPOST(req(h), ctx);
      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe('origin_not_allowed');
    }
    expect(f).not.toHaveBeenCalled();
  });

  it('same-origin legítimo se reenvía con Bearer e Idempotency-Key; status tal cual', async () => {
    const f = vi.fn(() => json(201, refund({ status: 'created' })));
    vi.stubGlobal('fetch', f);
    const res = await refundPOST(req(legit), ctx);
    expect(res.status).toBe(201);
    const [url, init] = f.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe(`${API}/v1/organizations/${ORG}/refunds`);
    const h = init.headers as Record<string, string>;
    expect(h['idempotency-key']).toBe('k-1');
    expect(h.authorization).toBe('Bearer session-token-test');

    vi.stubGlobal(
      'fetch',
      vi.fn(() => json(422, { error: { code: 'refund_amount_exceeds_remaining' } }))
    );
    const r422 = await refundPOST(req(legit), ctx);
    expect(r422.status).toBe(422);
    expect((await r422.json()).error.code).toBe('refund_amount_exceeds_remaining');
  });

  it('API inalcanzable ⇒ 502 upstream_unavailable (incierto, reintentable con la misma key)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('ECONNRESET')))
    );
    const res = await refundPOST(req(legit), ctx);
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe('upstream_unavailable');
  });

  it('sin cookie ⇒ 401 invalid_session; sin Idempotency-Key ⇒ 400', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    cookieState.value = null;
    const r401 = await refundPOST(req(legit), ctx);
    expect(r401.status).toBe(401);
    expect((await r401.json()).error.code).toBe('invalid_session');
    cookieState.value = 'session-token-test';
    const noKey = new Request(`${BASE}/api/orgs/${ORG}/refunds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...legit },
      body: '{}',
    });
    expect((await refundPOST(noKey, ctx)).status).toBe(400);
    expect(f).not.toHaveBeenCalled();
  });
});
