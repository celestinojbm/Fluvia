import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import {
  parseReceipt,
  pickMerchantName,
  pickReceiptPayment,
  pickReceiptSale,
  receiptRef,
} from '../app/lib/pos-receipt-contract';
import { PosReceiptView } from '../app/lib/pos-receipt';
import { PosRecentCharges } from '../app/lib/pos-recent';
import { joinRecentCharges } from '../app/lib/pos-reads';

/**
 * Justificante de cobro del POS (incremento 1). Datos SINTÉTICOS. Reglas:
 * solo cobros confirmados por la API, solo datos que la API devuelve, lectura
 * TODO o NADA, sin ids completos ni URLs, y nunca presentado como factura.
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
import { GET as receiptGET } from '../app/api/orgs/[orgId]/pos/payments/[paymentId]/receipt/route';

const ORG = '1bfed2e0-1de8-52d5-9352-0cfd7e27a5e1';
const PI = '57621b57-547b-4742-8f51-345696d4b3d2';
const LINK = 'b4247b5e-dadc-473b-a79f-0159205c9a92';
const MER = 'd948f551-b02a-5154-97dc-9d9e39919cf3';
const SID = '12d71f2e-5cf4-49df-ad73-4de51cdad6ae';
const API = 'http://127.0.0.1:3000';

const intent = (over: Record<string, unknown> = {}) => ({
  id: PI,
  object: 'payment_intent',
  merchant_id: MER,
  amount: 1250,
  currency: 'USD',
  status: 'succeeded',
  capture_method: 'automatic',
  amount_captured: 1250,
  amount_refunded: 0,
  failure_code: null,
  payment_link_id: LINK,
  created_at: '2026-09-30T14:00:00Z',
  ...over,
});
const merchant = (over: Record<string, unknown> = {}) => ({
  id: MER,
  name: 'Tienda Sintética',
  country: 'CO',
  defaultCurrency: 'USD',
  status: 'active',
  createdAt: '2026-07-01T00:00:00Z',
  ...over,
});
const sale = (over: Record<string, unknown> = {}) => ({
  object: 'payment_link_sale',
  payment_link: {
    id: LINK,
    object: 'payment_link',
    merchant_id: MER,
    amount: 1250,
    currency: 'USD',
    description: 'Café y bollería',
    status: 'active',
    url: `http://localhost:3100/l/${LINK}`,
    metadata: {},
    single_charge: true,
    checkout_tracking_since: '2026-09-29T00:00:00Z',
    created_at: '2026-09-30T13:59:00Z',
    disabled_at: null,
  },
  charge: 'charged',
  charge_payment_intent_id: PI,
  succeeded_count: 1,
  history: 'complete',
  truncated: false,
  checkouts: [
    {
      payment_intent_id: PI,
      payment_intent_status: 'succeeded',
      failure_code: null,
      amount_refunded: 0,
      created_at: '2026-09-30T14:00:00Z',
      checkout_session: {
        id: SID,
        status: 'completed',
        expires_at: '2026-09-30T15:00:00Z',
        completed_at: '2026-09-30T14:02:00Z',
        created_at: '2026-09-30T14:00:00Z',
      },
    },
  ],
  ...over,
});

const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

type H = () => Response;
type Api = { intent?: H | H[]; merchant?: H; sale?: H; refunds?: H | H[] };
const seqOf = (h: H | H[] | undefined, dflt: H) => {
  const q = Array.isArray(h) ? [...h] : [h ?? dflt];
  return () => (q.length > 1 ? q.shift()! : q[0]!)();
};
function mockApi(a: Api = {}) {
  const nextIntent = seqOf(a.intent, () => res(200, intent()));
  const nextRefunds = seqOf(a.refunds, () => res(200, { object: 'list', data: [] }));
  const f = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.endsWith(`/payment_intents/${PI}`)) return nextIntent();
    if (url.includes(`/refunds?`)) return nextRefunds();
    if (url.endsWith(`/merchants/${MER}`)) return (a.merchant ?? (() => res(200, merchant())))();
    if (url.endsWith(`/payment_links/${LINK}/sale`)) return (a.sale ?? (() => res(200, sale())))();
    throw new Error(`unexpected ${url}`);
  });
  vi.stubGlobal('fetch', f);
  return f;
}
const call = () =>
  receiptGET(new Request('http://dashboard.local/x'), {
    params: Promise.resolve({ orgId: ORG, paymentId: PI }),
  });
const codeOf = async (r: Response) => ((await r.json()) as { error: { code: string } }).error.code;

beforeEach(() => {
  cookieState.value = 'session-token-test';
  vi.stubEnv('FLUVIA_API_URL', API);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('contrato del justificante', () => {
  it('pickReceiptPayment: whitelist; amount_captured obligatorio', () => {
    const p = pickReceiptPayment({ ...intent(), client_secret: 'cs_x', url: 'http://x' });
    expect(p).toEqual({
      id: PI,
      merchant_id: MER,
      amount: 1250,
      currency: 'USD',
      status: 'succeeded',
      amount_captured: 1250,
      amount_refunded: 0,
      created_at: '2026-09-30T14:00:00Z',
      payment_link_id: LINK,
    });
    expect(pickReceiptPayment(intent({ amount_captured: undefined }))).toBeNull();
    expect(pickReceiptPayment(intent({ amount_captured: 1.5 }))).toBeNull();
    expect(pickReceiptPayment(intent({ currency: 'usd' }))).toBeNull();
    expect(pickReceiptPayment(intent({ payment_link_id: 'nope' }))).toBeNull();
    expect(pickReceiptPayment(intent({ payment_link_id: null }))?.payment_link_id).toBeNull();
  });

  it('pickReceiptSale: exige que el intent sea de la venta; concepto vacío ⇒ null', () => {
    expect(pickReceiptSale(sale(), LINK, PI)).toEqual({
      description: 'Café y bollería',
      checkout_completed_at: '2026-09-30T14:02:00Z',
    });
    expect(pickReceiptSale(sale(), LINK, SID)).toBeNull();
    expect(pickReceiptSale(sale(), MER, PI)).toBeNull();
    const blank = sale();
    blank.payment_link.description = '  ' as never;
    expect(pickReceiptSale(blank, LINK, PI)?.description).toBeNull();
  });

  it('pickMerchantName exige el comercio pedido', () => {
    expect(pickMerchantName(merchant(), MER)).toBe('Tienda Sintética');
    expect(pickMerchantName(merchant({ id: LINK }), MER)).toBeNull();
    expect(pickMerchantName(merchant({ name: '' }), MER)).toBeNull();
  });

  it('receiptRef: 8 últimos caracteres, jamás el id completo', () => {
    expect(receiptRef(PI)).toBe('96D4B3D2');
    expect(receiptRef(PI)).not.toContain('-');
  });
});

describe('BFF GET /api/orgs/:orgId/pos/payments/:id/receipt', () => {
  it('compone intent + comercio + venta por el plano de sesión y responde whitelist', async () => {
    const f = mockApi();
    const r = await call();
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const body = await r.json();
    expect(body).toEqual({
      payment: {
        id: PI,
        merchant_id: MER,
        amount: 1250,
        currency: 'USD',
        status: 'succeeded',
        amount_captured: 1250,
        amount_refunded: 0,
        created_at: '2026-09-30T14:00:00Z',
        payment_link_id: LINK,
      },
      merchant_name: 'Tienda Sintética',
      sale: { description: 'Café y bollería', checkout_completed_at: '2026-09-30T14:02:00Z' },
      refunds: [],
      refunds_truncated: false,
    });
    expect(JSON.stringify(body)).not.toMatch(/http|client_secret|metadata/);
    const urls = f.mock.calls.map((c) => String(c[0]));
    expect(urls.every((u) => u.startsWith(`${API}/v1/organizations/${ORG}/`))).toBe(true);
    const auth = (f.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(auth.authorization).toBe('Bearer session-token-test');
  });

  it('sin sesión ⇒ 401 sin tocar la API; ids no UUID ⇒ 400', async () => {
    const f = mockApi();
    cookieState.value = null;
    expect((await call()).status).toBe(401);
    cookieState.value = 'session-token-test';
    const bad = await receiptGET(new Request('http://dashboard.local/x'), {
      params: Promise.resolve({ orgId: ORG, paymentId: 'x' }),
    });
    expect(bad.status).toBe(400);
    expect(f).not.toHaveBeenCalled();
  });

  it.each(['requires_payment_method', 'processing', 'failed', 'canceled'])(
    'cobro %s ⇒ 409 not_charged (sin justificante de un cobro no confirmado)',
    async (status) => {
      const f = mockApi({ intent: () => res(200, intent({ status, amount_captured: 0 })) });
      const r = await call();
      expect(r.status).toBe(409);
      expect(await codeOf(r)).toBe('not_charged');
      expect(f).toHaveBeenCalledTimes(1);
    }
  );

  it.each(['partially_refunded', 'refunded'])('cobro %s sigue teniendo justificante', async (s) => {
    const settled = {
      id: '0b8e7c6d-5a4b-4c3d-8e2f-1a0b9c8d7e6f',
      object: 'refund',
      payment_intent_id: PI,
      amount: 500,
      currency: 'USD',
      status: 'succeeded',
      reason: null,
      failure_code: null,
      created_at: '2026-09-30T15:00:00Z',
    };
    mockApi({
      intent: () => res(200, intent({ status: s, amount_refunded: 500 })),
      refunds: () => res(200, { object: 'list', data: [settled] }),
    });
    expect((await call()).status).toBe(200);
  });

  it('cobro sin venta vinculada ⇒ sale null, sin leer la venta', async () => {
    const f = mockApi({ intent: () => res(200, intent({ payment_link_id: null })) });
    const r = await call();
    expect((await r.json()).sale).toBeNull();
    expect(f.mock.calls.some((c) => String(c[0]).includes('/payment_links/'))).toBe(false);
  });

  it('401 ⇒ invalid_session; 403/404 del cobro ⇒ not_found', async () => {
    mockApi({ intent: () => res(401, {}) });
    expect(await codeOf(await call())).toBe('invalid_session');
    mockApi({ intent: () => res(404, {}) });
    expect(await codeOf(await call())).toBe('not_found');
    mockApi({ intent: () => res(403, {}) });
    expect((await call()).status).toBe(404);
  });

  it('TODO o NADA: fallo o incoherencia en cualquier lectura ⇒ 502', async () => {
    const cases: Api[] = [
      { intent: () => res(500, {}) },
      { intent: () => res(200, intent({ id: SID })) },
      { merchant: () => res(500, {}) },
      { merchant: () => res(404, {}) },
      { merchant: () => res(200, merchant({ id: LINK })) },
      { sale: () => res(500, {}) },
      { sale: () => res(404, {}) },
      { sale: () => res(200, sale({ checkouts: [] })) },
    ];
    for (const c of cases) {
      mockApi(c);
      const r = await call();
      expect(r.status).toBe(502);
      expect(await codeOf(r)).toBe('upstream_unavailable');
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      })
    );
    expect((await call()).status).toBe(502);
  });
});

const receiptBody = (over: Record<string, unknown> = {}) => ({
  payment: {
    id: PI,
    merchant_id: MER,
    amount: 1250,
    currency: 'USD',
    status: 'succeeded',
    amount_captured: 1250,
    amount_refunded: 0,
    created_at: '2026-09-30T14:00:00Z',
    payment_link_id: LINK,
  },
  merchant_name: 'Tienda Sintética',
  sale: { description: 'Café y bollería', checkout_completed_at: '2026-09-30T14:02:00Z' },
  refunds: [],
  refunds_truncated: false,
  ...over,
});

function mockBff(...handlers: Array<() => Response | Promise<Response>>) {
  const q = [...handlers];
  const f = vi.fn(async (_url: string) => (q.length > 1 ? q.shift()! : q[0]!)());
  vi.stubGlobal('fetch', f);
  return f;
}

function renderView() {
  return render(<PosReceiptView orgId={ORG} orgName="Org Sintética" paymentId={PI} locale="es" />);
}

describe('PosReceiptView', () => {
  it('muestra solo datos de la API, sin ids completos, y se declara no fiscal (axe)', async () => {
    const f = mockBff(() => res(200, receiptBody()));
    const { container } = renderView();
    expect(screen.getByRole('status')).toHaveTextContent('Cargando justificante');
    expect(await screen.findByTestId('pos-receipt-captured')).toHaveTextContent(/12[.,]50/);
    expect(String(f.mock.calls[0]![0])).toBe(`/api/orgs/${ORG}/pos/payments/${PI}/receipt`);
    expect(screen.getByRole('heading', { name: 'Justificante de cobro' })).toBeInTheDocument();
    expect(screen.getByTestId('pos-receipt-status')).toHaveTextContent('Cobro confirmado');
    expect(screen.getByTestId('pos-receipt-concept')).toHaveTextContent('Café y bollería');
    expect(screen.getByText('Tienda Sintética')).toBeInTheDocument();
    expect(screen.getByText('Org Sintética')).toBeInTheDocument();
    expect(screen.getByTestId('pos-receipt-ref')).toHaveTextContent('96D4B3D2');
    const note = screen.getByTestId('pos-receipt-not-fiscal');
    expect(note).toHaveTextContent('No es una factura ni un documento fiscal');
    const text = container.textContent ?? '';
    for (const id of [PI, LINK, MER, SID]) expect(text).not.toContain(id);
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toMatch(/\bIVA\b|\bNIT\b|[Ff]actura (n\.|nº|número)/);
    const r = await axe.run(container, { rules: { region: { enabled: false } } });
    expect(r.violations).toEqual([]);
  });

  it('«Imprimir justificante» llama a window.print', async () => {
    const user = userEvent.setup();
    mockBff(() => res(200, receiptBody()));
    const print = vi.fn();
    vi.stubGlobal('print', print);
    renderView();
    await user.click(await screen.findByRole('button', { name: 'Imprimir justificante' }));
    expect(print).toHaveBeenCalledTimes(1);
  });

  it('sin venta vinculada lo dice; importe de venta solo si difiere del capturado', async () => {
    mockBff(() =>
      res(
        200,
        receiptBody({
          sale: null,
          payment: { ...receiptBody().payment, amount: 2000, payment_link_id: null },
        })
      )
    );
    renderView();
    expect(await screen.findByTestId('pos-receipt-concept')).toHaveTextContent(
      'sin venta vinculada'
    );
    expect(screen.getByText('Importe de la venta')).toBeInTheDocument();
    expect(screen.queryByText('Checkout completado')).toBeNull();
  });

  it('409 ⇒ «no confirmado», sin justificante ni imprimir', async () => {
    mockBff(() => res(409, { ok: false, error: { code: 'not_charged' } }));
    renderView();
    expect(await screen.findByRole('alert')).toHaveTextContent('no está confirmado');
    expect(screen.queryByRole('button', { name: 'Imprimir justificante' })).toBeNull();
    expect(screen.queryByTestId('pos-receipt-captured')).toBeNull();
  });

  it('fallo de lectura ⇒ error con reintento; respuesta malformada no se muestra', async () => {
    const user = userEvent.setup();
    mockBff(
      () => res(502, { ok: false, error: { code: 'upstream_unavailable' } }),
      () => res(200, { ...receiptBody(), merchant_name: '' }),
      () => res(200, receiptBody())
    );
    renderView();
    expect(await screen.findByRole('alert')).toHaveTextContent('No pudimos leer este cobro');
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No pudimos leer este cobro');
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByTestId('pos-receipt-captured')).toBeInTheDocument();
  });

  it('parseReceipt rechaza formas inesperadas', () => {
    expect(parseReceipt(receiptBody())).not.toBeNull();
    expect(parseReceipt({ ...receiptBody(), sale: 'x' })).toBeNull();
    expect(parseReceipt({ ...receiptBody(), payment: { id: PI } })).toBeNull();
  });
});

describe('acceso desde «Cobros recientes»', () => {
  const s = (n: number, intentId: string) => ({
    id: `00000000-0000-4000-8000-00000000000${n}`,
    status: 'completed',
    payment_intent_id: intentId,
    created_at: `2026-09-30T1${n}:00:00Z`,
    expires_at: '2026-09-30T23:00:00Z',
  });
  const i = (id: string, status: string) => ({
    id,
    merchant_id: MER,
    amount: 1250,
    currency: 'USD',
    status,
    payment_link_id: LINK,
  });

  it('«Ver justificante» solo en cobros confirmados, con la ruta del justificante', async () => {
    const OK = '11111111-0000-4000-8000-000000000001';
    const REF = '11111111-0000-4000-8000-000000000002';
    const BAD = '11111111-0000-4000-8000-000000000003';
    render(
      <PosRecentCharges
        orgId={ORG}
        locale="es"
        merchants={[{ id: MER, name: 'Tienda Sintética' }]}
        initial={joinRecentCharges(
          [s(1, OK), s(2, REF), s(3, BAD)],
          [i(OK, 'succeeded'), i(REF, 'partially_refunded'), i(BAD, 'failed')]
        )}
      />
    );
    const links = screen.getAllByTestId('pos-recent-receipt');
    expect(links.map((l) => l.getAttribute('href')).sort()).toEqual(
      [`/o/${ORG}/pos/receipts/${OK}`, `/o/${ORG}/pos/receipts/${REF}`].sort()
    );
  });
});
