import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { parseReceipt, refundsConsistent } from '../app/lib/pos-receipt-contract';
import { PosReceiptView } from '../app/lib/pos-receipt';

/**
 * Justificante — devoluciones y estados (incremento 2). Datos SINTÉTICOS.
 * Reglas: el importe devuelto es el `amount_refunded` de la API; una
 * `indeterminate` es «pendiente de verificación» y jamás cuenta como devuelta;
 * instantánea coherente (cobro↔lista) o no hay justificante; el motivo del
 * cajero no sale; relectura fallida ⇒ datos desactualizados NO imprimibles;
 * sesión caducada ⇒ datos retirados.
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
const MER = 'd948f551-b02a-5154-97dc-9d9e39919cf3';
const rid = (n: number) => `0b8e7c6d-5a4b-4c3d-8e2f-${String(n).padStart(12, '0')}`;

const intent = (over: Record<string, unknown> = {}) => ({
  id: PI,
  object: 'payment_intent',
  merchant_id: MER,
  amount: 10000,
  currency: 'USD',
  status: 'succeeded',
  capture_method: 'automatic',
  amount_captured: 10000,
  amount_refunded: 0,
  failure_code: null,
  payment_link_id: null,
  created_at: '2026-09-30T14:00:00Z',
  ...over,
});
const apiRefund = (
  n: number,
  amount: number,
  status: string,
  over: Record<string, unknown> = {}
) => ({
  id: rid(n),
  object: 'refund',
  payment_intent_id: PI,
  amount,
  currency: 'USD',
  status,
  reason: 'Nota interna del cajero: cliente Ana, tel 555-0100',
  failure_code: status === 'canceled' ? 'insufficient_merchant_balance' : null,
  created_at: `2026-09-30T15:0${n}:00Z`,
  ...over,
});
const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const list = (...data: unknown[]) => res(200, { object: 'list', data });

type H = () => Response;
function mockApi(a: { intent?: H[]; refunds?: H[] }) {
  const qi = [...(a.intent ?? [() => res(200, intent())])];
  const qr = [...(a.refunds ?? [() => list()])];
  const next = (q: H[]) => (q.length > 1 ? q.shift()! : q[0]!)();
  const f = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.endsWith(`/payment_intents/${PI}`)) return next(qi);
    if (url.includes('/refunds?')) return next(qr);
    if (url.endsWith(`/merchants/${MER}`)) return res(200, { id: MER, name: 'Tienda Sintética' });
    throw new Error(`unexpected ${url}`);
  });
  vi.stubGlobal('fetch', f);
  return f;
}
const call = () =>
  receiptGET(new Request('http://dashboard.local/x'), {
    params: Promise.resolve({ orgId: ORG, paymentId: PI }),
  });

beforeEach(() => {
  cookieState.value = 'session-token-test';
  vi.stubEnv('FLUVIA_API_URL', 'http://127.0.0.1:3000');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('BFF del justificante — devoluciones', () => {
  it('lee la lista del cobro (limit 100) y quita motivo y failure_code', async () => {
    const f = mockApi({
      intent: [() => res(200, intent({ status: 'partially_refunded', amount_refunded: 2500 }))],
      refunds: [() => list(apiRefund(1, 2500, 'succeeded'), apiRefund(2, 1000, 'indeterminate'))],
    });
    const r = await call();
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.refunds).toEqual([
      {
        id: rid(2),
        amount: 1000,
        currency: 'USD',
        status: 'indeterminate',
        created_at: '2026-09-30T15:02:00Z',
      },
      {
        id: rid(1),
        amount: 2500,
        currency: 'USD',
        status: 'succeeded',
        created_at: '2026-09-30T15:01:00Z',
      },
    ]);
    expect(body.refunds_truncated).toBe(false);
    expect(JSON.stringify(body)).not.toMatch(/Nota interna|Ana|555|failure_code|reason/);
    const refundsUrl = f.mock.calls.map((c) => String(c[0])).find((u) => u.includes('/refunds?'))!;
    expect(new URL(refundsUrl).searchParams.get('payment_intent_id')).toBe(PI);
    expect(new URL(refundsUrl).searchParams.get('limit')).toBe('100');
  });

  it('una devolución se liquida entre lecturas ⇒ repite y entrega una instantánea coherente', async () => {
    const f = mockApi({
      intent: [
        () => res(200, intent()),
        () => res(200, intent({ status: 'partially_refunded', amount_refunded: 2500 })),
        () => res(200, intent({ status: 'partially_refunded', amount_refunded: 2500 })),
      ],
      refunds: [
        () => list(apiRefund(1, 2500, 'processing')),
        () => list(apiRefund(1, 2500, 'succeeded')),
      ],
    });
    const r = await call();
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.payment.amount_refunded).toBe(2500);
    expect(body.refunds[0].status).toBe('succeeded');
    expect(f.mock.calls.filter((c) => String(c[0]).includes('/refunds?'))).toHaveLength(2);
  });

  it('el cobro no se estabiliza en 3 intentos ⇒ 502 (sin justificante)', async () => {
    let n = 0;
    mockApi({
      intent: [
        () => res(200, intent({ status: 'partially_refunded', amount_refunded: ++n * 100 })),
      ],
      refunds: [() => list()],
    });
    expect((await call()).status).toBe(502);
  });

  it('Σ succeeded ≠ amount_refunded con la lista completa ⇒ 502', async () => {
    mockApi({
      intent: [() => res(200, intent({ status: 'partially_refunded', amount_refunded: 2500 }))],
      refunds: [() => list(apiRefund(1, 2000, 'succeeded'))],
    });
    expect((await call()).status).toBe(502);
  });

  it('una indeterminate NO cuadra como devuelta: si la API no la sumó, el justificante tampoco', async () => {
    mockApi({
      intent: [() => res(200, intent())],
      refunds: [() => list(apiRefund(1, 10000, 'indeterminate'))],
    });
    const body = await (await call()).json();
    expect(body.payment.amount_refunded).toBe(0);
    expect(body.refunds[0].status).toBe('indeterminate');
  });

  it('lista truncada (100) ⇒ se marca y no se exige el cuadre', async () => {
    const many = Array.from({ length: 100 }, (_, i) => apiRefund(i + 1, 1, 'failed'));
    mockApi({
      intent: [() => res(200, intent({ status: 'partially_refunded', amount_refunded: 9999 }))],
      refunds: [() => list(...many)],
    });
    const r = await call();
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.refunds_truncated).toBe(true);
    // Nunca un desglose parcial: la API da las 100 MÁS RECIENTES y una
    // devolución pendiente antigua quedaría fuera.
    expect(body.refunds).toEqual([]);
    expect(body.payment.amount_refunded).toBe(9999);
  });

  it('lista malformada, de otro cobro o fallida ⇒ 502; 401 ⇒ 401', async () => {
    for (const h of [
      () => list(apiRefund(1, 100, 'weird')),
      () => list(apiRefund(1, 100, 'succeeded', { payment_intent_id: MER })),
      () => res(500, {}),
      () => res(404, {}),
    ]) {
      mockApi({ refunds: [h] });
      expect((await call()).status).toBe(502);
    }
    mockApi({ refunds: [() => res(401, {})] });
    expect((await call()).status).toBe(401);
  });

  it('refundsConsistent exige la moneda del cobro', () => {
    const r = [
      { id: rid(1), amount: 1, currency: 'EUR', status: 'succeeded' as const, created_at: 'x' },
    ];
    expect(refundsConsistent({ currency: 'USD', amount_refunded: 1 }, r, false)).toBe(false);
    expect(refundsConsistent({ currency: 'USD', amount_refunded: 1 }, r, true)).toBe(false);
  });
});

// ------------------------------------------------------------------ vista

const bffRefund = (n: number, amount: number, status: string) => ({
  id: rid(n),
  amount,
  currency: 'USD',
  status,
  created_at: `2026-09-30T15:0${n}:00Z`,
});
const receipt = (
  over: { status?: string; refunded?: number; refunds?: unknown[]; truncated?: boolean } = {}
) => ({
  payment: {
    id: PI,
    merchant_id: MER,
    amount: 10000,
    currency: 'USD',
    status: over.status ?? 'succeeded',
    amount_captured: 10000,
    amount_refunded: over.refunded ?? 0,
    created_at: '2026-09-30T14:00:00Z',
    payment_link_id: null,
  },
  merchant_name: 'Tienda Sintética',
  sale: null,
  refunds: over.refunds ?? [],
  refunds_truncated: over.truncated ?? false,
});

function mockBff(...handlers: Array<() => Response | Promise<Response>>) {
  const q = [...handlers];
  const f = vi.fn(async (_url: string) => (q.length > 1 ? q.shift()! : q[0]!)());
  vi.stubGlobal('fetch', f);
  return f;
}
const renderView = (locale: 'es' | 'en' = 'es') =>
  render(<PosReceiptView orgId={ORG} orgName="Org Sintética" paymentId={PI} locale={locale} />);

describe('PosReceiptView — devoluciones', () => {
  it('parcial: devuelto = amount_refunded de la API, título con devoluciones (axe)', async () => {
    mockBff(() =>
      res(
        200,
        receipt({
          status: 'partially_refunded',
          refunded: 2500,
          refunds: [bffRefund(2, 1000, 'failed'), bffRefund(1, 2500, 'succeeded')],
        })
      )
    );
    const { container } = renderView();
    expect(await screen.findByTestId('pos-receipt-refunded')).toHaveTextContent(/25[.,]00/);
    expect(
      screen.getByRole('heading', { name: 'Justificante de cobro y devoluciones' })
    ).toBeInTheDocument();
    expect(screen.getByTestId('pos-receipt-status')).toHaveTextContent('devolución parcial');
    const items = screen.getAllByTestId('pos-receipt-refund');
    expect(items.map((i) => i.dataset.status)).toEqual(['failed', 'succeeded']);
    expect(items[0]).toHaveTextContent('No devuelta (rechazada)');
    expect(items[0]).toHaveTextContent('El importe no se devolvió');
    expect(items[1]).toHaveTextContent('Devuelta');
    expect(screen.queryByTestId('pos-receipt-uncertain')).toBeNull();
    expect(container.textContent).not.toContain(rid(1));
    const r = await axe.run(container, { rules: { region: { enabled: false } } });
    expect(r.violations).toEqual([]);
  });

  it('total: estado de la API «devuelto por completo»', async () => {
    mockBff(() =>
      res(
        200,
        receipt({
          status: 'refunded',
          refunded: 10000,
          refunds: [bffRefund(1, 10000, 'succeeded')],
        })
      )
    );
    renderView();
    expect(await screen.findByTestId('pos-receipt-status')).toHaveTextContent(
      'devuelto por completo'
    );
    expect(screen.getByTestId('pos-receipt-refunded')).toHaveTextContent(/100[.,]00/);
  });

  it('indeterminate: «pendiente de verificación», NUNCA sumada como devuelta', async () => {
    mockBff(() => res(200, receipt({ refunds: [bffRefund(1, 10000, 'indeterminate')] })));
    renderView();
    const item = await screen.findByTestId('pos-receipt-refund');
    expect(item).toHaveTextContent('Pendiente de verificación');
    expect(item).toHaveTextContent('No se da por devuelta');
    expect(item).not.toHaveTextContent(/^Devuelta/);
    expect(screen.getByTestId('pos-receipt-uncertain')).toHaveTextContent(
      'NO las cuenta como devueltas'
    );
    // Devuelto confirmado = 0 (API); el estado del cobro sigue siendo el de la API.
    expect(screen.getByTestId('pos-receipt-refunded')).toHaveTextContent(/0[.,]00/);
    expect(screen.getByTestId('pos-receipt-status')).toHaveTextContent(/^Cobro confirmado$/);
    // Se puede imprimir tal cual: el papel dice que está pendiente.
    expect(screen.getByRole('button', { name: 'Imprimir justificante' })).toBeEnabled();
  });

  it('en curso: se dice que aún no cuenta como devuelta', async () => {
    mockBff(() => res(200, receipt({ refunds: [bffRefund(1, 500, 'processing')] })));
    renderView();
    expect(await screen.findByTestId('pos-receipt-open')).toHaveTextContent('Aún no cuentan');
    expect(screen.getByTestId('pos-receipt-refund')).toHaveTextContent('aún no se ha devuelto');
  });

  it('lista truncada: sin desglose ni avisos derivados de él; solo el total de la API', async () => {
    mockBff(() =>
      res(200, receipt({ truncated: true, status: 'partially_refunded', refunded: 9999 }))
    );
    const { container } = renderView();
    const note = await screen.findByTestId('pos-receipt-truncated');
    expect(note).toHaveTextContent('NO incluye el desglose');
    expect(note).toHaveTextContent('100 devoluciones o más');
    expect(
      screen.getByRole('heading', { name: 'Justificante de cobro y devoluciones' })
    ).toBeInTheDocument();
    expect(note).toHaveTextContent('no se puede saber si hay devoluciones en curso o pendientes');
    // El aviso se imprime (no lleva .no-print) y no hay lista ni «sin devoluciones».
    expect(note.closest('.no-print')).toBeNull();
    expect(screen.queryByTestId('pos-receipt-refund')).toBeNull();
    expect(screen.queryByText('Sin devoluciones registradas.')).toBeNull();
    expect(screen.queryByTestId('pos-receipt-uncertain')).toBeNull();
    expect(screen.getByTestId('pos-receipt-refunded')).toHaveTextContent(/99[.,]99/);
    const r = await axe.run(container, { rules: { region: { enabled: false } } });
    expect(r.violations).toEqual([]);
  });

  it('parseReceipt rechaza un desglose junto a refunds_truncated (sería parcial)', () => {
    const partial = receipt({ truncated: true, refunds: [bffRefund(1, 500, 'succeeded')] });
    expect(parseReceipt(partial)).toBeNull();
  });

  it('respuesta con totales incoherentes no se muestra (parseReceipt)', async () => {
    const bad = receipt({ refunded: 0, refunds: [bffRefund(1, 500, 'succeeded')] });
    expect(parseReceipt(bad)).toBeNull();
    mockBff(() => res(200, bad));
    renderView();
    expect(await screen.findByTestId('pos-receipt-alert')).toHaveAttribute('data-kind', 'error');
    expect(screen.queryByTestId('pos-receipt-refunded')).toBeNull();
  });

  it('en inglés', async () => {
    mockBff(() => res(200, receipt({ refunds: [bffRefund(1, 500, 'indeterminate')] })));
    renderView('en');
    expect(await screen.findByTestId('pos-receipt-refund')).toHaveTextContent(
      'Pending verification'
    );
    expect(screen.getByTestId('pos-receipt-not-fiscal')).toHaveTextContent('not an invoice');
  });
});

describe('PosReceiptView — estados y teclado', () => {
  it('relectura fallida ⇒ datos desactualizados, impresión bloqueada, foco en el aviso; reintento la reactiva', async () => {
    const user = userEvent.setup();
    mockBff(
      () => res(200, receipt()),
      () => res(502, { ok: false, error: { code: 'upstream_unavailable' } }),
      () =>
        res(
          200,
          receipt({
            status: 'refunded',
            refunded: 10000,
            refunds: [bffRefund(1, 10000, 'succeeded')],
          })
        )
    );
    renderView();
    await user.click(await screen.findByRole('button', { name: 'Actualizar' }));
    const alert = await screen.findByTestId('pos-receipt-alert');
    expect(alert).toHaveAttribute('data-kind', 'stale');
    expect(alert).toHaveTextContent('puede estar desactualizado');
    await waitFor(() => expect(alert).toHaveFocus());
    const print = screen.getByRole('button', { name: 'Imprimir justificante' });
    expect(print).toBeDisabled();
    // En papel (menú del navegador) solo saldría el aviso de NO válido.
    expect(screen.getByTestId('pos-receipt-print-stale')).toHaveTextContent('NO VÁLIDO');
    expect(screen.getByTestId('pos-receipt-print-stale')).toHaveClass('print-only');
    expect(print).toHaveAttribute('aria-describedby', 'pos-receipt-stale pos-receipt-print-hint');
    // Los datos previos siguen a la vista (marcados), no se inventa nada nuevo.
    expect(screen.getByTestId('pos-receipt')).toHaveClass('pos-stale-receipt');
    await user.click(within(alert).getByRole('button', { name: 'Reintentar' }));
    await waitFor(() =>
      expect(screen.getByTestId('pos-receipt-status')).toHaveTextContent('devuelto por completo')
    );
    expect(screen.getByRole('button', { name: 'Imprimir justificante' })).toBeEnabled();
    expect(screen.getByRole('status')).toHaveTextContent('Justificante actualizado');
  });

  it('sesión caducada al actualizar ⇒ se retiran los datos y se ofrece iniciar sesión', async () => {
    const user = userEvent.setup();
    mockBff(
      () =>
        res(
          200,
          receipt({
            refunds: [bffRefund(1, 500, 'succeeded')],
            refunded: 500,
            status: 'partially_refunded',
          })
        ),
      () => res(401, { ok: false, error: { code: 'invalid_session' } })
    );
    renderView();
    await user.click(await screen.findByRole('button', { name: 'Actualizar' }));
    const alert = await screen.findByTestId('pos-receipt-alert');
    expect(alert).toHaveAttribute('data-kind', 'auth');
    expect(within(alert).getByRole('link', { name: 'Vuelve a iniciar sesión' })).toHaveAttribute(
      'href',
      '/login'
    );
    expect(screen.queryByTestId('pos-receipt-captured')).toBeNull();
    expect(screen.queryByTestId('pos-receipt-refund')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Imprimir justificante' })).toBeNull();
  });

  it('carga: aria-busy y «Actualizando…» sin doble lectura', async () => {
    const user = userEvent.setup();
    let release!: () => void;
    const f = mockBff(
      () => res(200, receipt()),
      () => new Promise<Response>((ok) => (release = () => ok(res(200, receipt()))))
    );
    renderView();
    await user.click(await screen.findByRole('button', { name: 'Actualizar' }));
    const busy = screen.getByRole('button', { name: 'Actualizando…' });
    expect(busy).toBeDisabled();
    expect(screen.getByTestId('pos-receipt')).toHaveAttribute('aria-busy', 'true');
    expect(f).toHaveBeenCalledTimes(2);
    release();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Actualizar' })).toBeEnabled());
  });

  it('solo teclado: Tab recorre Imprimir → Actualizar → Volver; Enter actualiza', async () => {
    const user = userEvent.setup();
    const f = mockBff(() => res(200, receipt()));
    renderView();
    await screen.findByTestId('pos-receipt-captured');
    await user.tab();
    expect(screen.getByRole('button', { name: 'Imprimir justificante' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Actualizar' })).toHaveFocus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(f).toHaveBeenCalledTimes(2));
    await user.tab();
    expect(screen.getByRole('link', { name: 'Volver al POS' })).toHaveAttribute(
      'href',
      `/o/${ORG}/pos`
    );
  });
});
