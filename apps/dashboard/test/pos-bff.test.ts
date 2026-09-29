import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../app/lib/csrf-header';
import { POST as openPOST } from '../app/api/orgs/[orgId]/pos/checkout/route';
import { GET as statusGET } from '../app/api/orgs/[orgId]/pos/sessions/[sessionId]/route';
import { POST as linkPOST } from '../app/api/orgs/[orgId]/payment-links/route';

/**
 * POS sandbox — BFF. Apertura de checkout: CSRF primero, sesión, rol,
 * PROPIEDAD del link por el plano de sesión antes de tocar el endpoint
 * público, contrato estricto y resultado incierto explícito. Estado: lecturas
 * por sesión, 404/401/502 distinguidos, respuesta por whitelist. Payment
 * links: ahora con guard CSRF.
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
const LINK = 'b4247b5e-dadc-473b-a79f-0159205c9a92';
const SID = '12d71f2e-5cf4-49df-ad73-4de51cdad6ae';
const PI = '57621b57-547b-4742-8f51-345696d4b3d2';
const BASE = 'http://dashboard.local';
const API = 'http://127.0.0.1:3000';

const legit = () => ({
  origin: BASE,
  'sec-fetch-site': 'same-origin',
  [CSRF_HEADER]: CSRF_HEADER_VALUE,
});

function openReq(headers: Record<string, string>, body: unknown = { payment_link_id: LINK }) {
  return new Request(`${BASE}/api/orgs/${ORG}/pos/checkout`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}
const openCtx = { params: Promise.resolve({ orgId: ORG }) };

const json = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

type Route = (url: string, init?: RequestInit) => Promise<Response>;
function routeFetch(routes: Record<string, Route>) {
  const f = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const key = `${method} ${url.replace(API, '')}`;
    const h = routes[key];
    if (!h) throw new Error(`unexpected fetch ${key}`);
    return h(url, init);
  });
  vi.stubGlobal('fetch', f);
  return f;
}

const ORGS_OK: Route = () =>
  json(200, { organizations: [{ organization_id: ORG, name: 'Demo', slug: 'd', role: 'owner' }] });
const LINK_OK: Route = () => json(200, { id: LINK, status: 'active' });
const OPEN_OK: Route = () =>
  json(200, {
    object: 'checkout_session',
    checkout_session_id: SID,
    client_secret: 'cs_secret-123',
    url: `http://localhost:3100/c/${SID}`,
  });

const ORGS_PATH = 'GET /v1/organizations';
const LINK_PATH = `GET /v1/organizations/${ORG}/payment_links/${LINK}`;
const OPEN_PATH = `POST /v1/payment_links/${LINK}/sessions`;

beforeEach(() => {
  cookieState.value = 'session-token-test';
  vi.stubEnv('FLUVIA_DASHBOARD_ORIGIN', BASE);
  vi.stubEnv('FLUVIA_API_URL', API);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('POST /api/orgs/:orgId/pos/checkout', () => {
  it.each([
    [
      'cross-site',
      { origin: 'https://attacker.test', 'sec-fetch-site': 'cross-site', [CSRF_HEADER]: '1' },
    ],
    ['sin Origin', { 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: '1' }],
    ['sin header CSRF', { origin: BASE, 'sec-fetch-site': 'same-origin' }],
  ])('CSRF %s ⇒ 403 sin tocar el backend', async (_n, headers) => {
    const f = routeFetch({});
    const res = await openPOST(openReq(headers as Record<string, string>), openCtx);
    expect(res.status).toBe(403);
    expect(f).not.toHaveBeenCalled();
  });

  it('sin sesión ⇒ 401; body inválido ⇒ 400; nada se llama', async () => {
    const f = routeFetch({});
    cookieState.value = null;
    expect((await openPOST(openReq(legit()), openCtx)).status).toBe(401);
    cookieState.value = 'tok';
    expect((await openPOST(openReq(legit(), { payment_link_id: 'x' }), openCtx)).status).toBe(400);
    expect((await openPOST(openReq(legit(), {}), openCtx)).status).toBe(400);
    expect(f).not.toHaveBeenCalled();
  });

  it('camino feliz: rol → propiedad → apertura; secreto SOLO en el fragmento', async () => {
    const f = routeFetch({ [ORGS_PATH]: ORGS_OK, [LINK_PATH]: LINK_OK, [OPEN_PATH]: OPEN_OK });
    const res = await openPOST(openReq(legit()), openCtx);
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body).toEqual({
      checkout_session_id: SID,
      checkout_url: `http://localhost:3100/c/${SID}#cs_secret-123`,
    });
    expect(
      f.mock.calls.map((c) => `${c[1]?.method ?? 'GET'} ${String(c[0]).replace(API, '')}`)
    ).toEqual([ORGS_PATH, LINK_PATH, OPEN_PATH]);
    // Bearer solo hacia el plano de sesión; el endpoint público va sin credencial.
    const openInit = f.mock.calls[2]![1] as RequestInit;
    expect(JSON.stringify(openInit.headers ?? {})).not.toContain('Bearer');
  });

  it('rol sin reconciliation:manage ⇒ 403 y jamás se abre la sesión', async () => {
    const f = routeFetch({
      [ORGS_PATH]: () =>
        json(200, { organizations: [{ organization_id: ORG, role: 'developer' }] }),
    });
    const res = await openPOST(openReq(legit()), openCtx);
    expect(res.status).toBe(403);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('org sin membresía ⇒ 404', async () => {
    routeFetch({ [ORGS_PATH]: () => json(200, { organizations: [] }) });
    expect((await openPOST(openReq(legit()), openCtx)).status).toBe(404);
  });

  it('link AJENO (404 por sesión) ⇒ 404 y el endpoint público NO se toca', async () => {
    const f = routeFetch({ [ORGS_PATH]: ORGS_OK, [LINK_PATH]: () => json(404, {}) });
    const res = await openPOST(openReq(legit()), openCtx);
    expect(res.status).toBe(404);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('link deshabilitado ⇒ 409 link_unavailable sin abrir', async () => {
    const f = routeFetch({
      [ORGS_PATH]: ORGS_OK,
      [LINK_PATH]: () => json(200, { id: LINK, status: 'disabled' }),
    });
    const res = await openPOST(openReq(legit()), openCtx);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('link_unavailable');
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('fallo de lectura previo ⇒ 502 upstream_unavailable (nada creado)', async () => {
    routeFetch({ [ORGS_PATH]: () => Promise.reject(new Error('down')) });
    const res = await openPOST(openReq(legit()), openCtx);
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe('upstream_unavailable');
  });

  it.each([
    ['red caída', () => Promise.reject(new Error('reset'))],
    ['5xx', () => json(500, {})],
    ['201 inesperado', () => json(201, {})],
    ['200 sin secreto', () => json(200, { checkout_session_id: SID, url: `http://x/c/${SID}` })],
    [
      '200 url incoherente',
      () => json(200, { checkout_session_id: SID, client_secret: 's', url: 'http://x/c/otra' }),
    ],
    [
      '200 url no http',
      () =>
        json(200, { checkout_session_id: SID, client_secret: 's', url: `javascript:x/c/${SID}` }),
    ],
  ])('apertura %s ⇒ 502 checkout_open_uncertain', async (_n, open) => {
    routeFetch({ [ORGS_PATH]: ORGS_OK, [LINK_PATH]: LINK_OK, [OPEN_PATH]: open as Route });
    const res = await openPOST(openReq(legit()), openCtx);
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe('checkout_open_uncertain');
  });

  it('apertura 404 (carrera: link deshabilitado) ⇒ 409; 429 ⇒ 429', async () => {
    routeFetch({ [ORGS_PATH]: ORGS_OK, [LINK_PATH]: LINK_OK, [OPEN_PATH]: () => json(404, {}) });
    expect((await openPOST(openReq(legit()), openCtx)).status).toBe(409);
    routeFetch({ [ORGS_PATH]: ORGS_OK, [LINK_PATH]: LINK_OK, [OPEN_PATH]: () => json(429, {}) });
    expect((await openPOST(openReq(legit()), openCtx)).status).toBe(429);
  });
});

describe('GET /api/orgs/:orgId/pos/sessions/:id', () => {
  const ctx = { params: Promise.resolve({ orgId: ORG, sessionId: SID }) };
  const req = () => new Request(`${BASE}/api/orgs/${ORG}/pos/sessions/${SID}`);
  const S_PATH = `GET /v1/organizations/${ORG}/checkout_sessions/${SID}`;
  const P_PATH = `GET /v1/organizations/${ORG}/payment_intents/${PI}`;
  const SESSION = {
    id: SID,
    payment_intent_id: PI,
    status: 'open',
    url: 'u',
    expires_at: '2026-09-30T00:00:00Z',
    completed_at: null,
    created_at: '2026-09-29T00:00:00Z',
    customer_id: 'leak-me-not',
  };
  const INTENT = {
    id: PI,
    merchant_id: 'm',
    amount: 2500,
    currency: 'USD',
    status: 'succeeded',
    failure_code: null,
    amount_refunded: 0,
    capture_method: 'automatic',
  };

  it('combina sesión + intent por whitelist', async () => {
    routeFetch({ [S_PATH]: () => json(200, SESSION), [P_PATH]: () => json(200, INTENT) });
    const res = await statusGET(req(), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.payment.status).toBe('succeeded');
    expect(JSON.stringify(body)).not.toContain('leak-me-not');
    expect(body.payment).not.toHaveProperty('capture_method');
  });

  it('sin sesión ⇒ 401; ids inválidos ⇒ 400', async () => {
    const f = routeFetch({});
    cookieState.value = null;
    expect((await statusGET(req(), ctx)).status).toBe(401);
    cookieState.value = 'tok';
    const bad = { params: Promise.resolve({ orgId: ORG, sessionId: '../x' }) };
    expect((await statusGET(req(), bad)).status).toBe(400);
    expect(f).not.toHaveBeenCalled();
  });

  it('404 (otra org / inexistente) ⇒ 404; 401 del API ⇒ 401', async () => {
    routeFetch({ [S_PATH]: () => json(404, {}) });
    expect((await statusGET(req(), ctx)).status).toBe(404);
    routeFetch({ [S_PATH]: () => json(401, {}) });
    expect((await statusGET(req(), ctx)).status).toBe(401);
  });

  it('un fallo de lectura jamás se presenta como estado: 502', async () => {
    routeFetch({ [S_PATH]: () => Promise.reject(new Error('x')) });
    expect((await statusGET(req(), ctx)).status).toBe(502);
    routeFetch({ [S_PATH]: () => json(500, {}) });
    expect((await statusGET(req(), ctx)).status).toBe(502);
    routeFetch({ [S_PATH]: () => json(200, SESSION), [P_PATH]: () => json(404, {}) });
    expect((await statusGET(req(), ctx)).status).toBe(502);
    routeFetch({
      [S_PATH]: () => json(200, SESSION),
      [P_PATH]: () => json(200, { ...INTENT, id: SID }),
    });
    expect((await statusGET(req(), ctx)).status).toBe(502);
  });
});

describe('POST /api/orgs/:orgId/payment-links (guard CSRF)', () => {
  const ctx = { params: Promise.resolve({ orgId: ORG }) };
  const req = (headers: Record<string, string>) =>
    new Request(`${BASE}/api/orgs/${ORG}/payment-links`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'k-1', ...headers },
      body: '{}',
    });

  it('rechaza cross-site y sin header CSRF sin tocar el backend', async () => {
    const f = routeFetch({});
    expect(
      (
        await linkPOST(
          req({ origin: 'https://evil.test', 'sec-fetch-site': 'cross-site', [CSRF_HEADER]: '1' }),
          ctx
        )
      ).status
    ).toBe(403);
    expect(
      (await linkPOST(req({ origin: BASE, 'sec-fetch-site': 'same-origin' }), ctx)).status
    ).toBe(403);
    expect(f).not.toHaveBeenCalled();
  });

  it('same-origin legítimo se reenvía con la Idempotency-Key', async () => {
    const f = routeFetch({
      [`POST /v1/organizations/${ORG}/payment_links`]: () => json(201, { id: LINK }),
    });
    const res = await linkPOST(req(legit()), ctx);
    expect(res.status).toBe(201);
    const init = f.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)['idempotency-key']).toBe('k-1');
  });
});
