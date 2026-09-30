import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PosRefundPanel } from '../app/lib/pos-refund';
import { PosTerminal } from '../app/lib/pos-terminal';
import type { Merchant } from '../app/lib/api';
import type { PosSaleStatus } from '../app/lib/pos-contract';

/**
 * Devolución de un cobro del POS (jsdom). Recorrido completo y sus garantías:
 * importe confirmado explícito, una sola Idempotency-Key por borrador (misma
 * key al reintentar tras un resultado incierto), un solo POST ante doble
 * envío, cupo conservador y — sobre todo — devolver NO reabre la venta.
 */

const ORG = '1bfed2e0-1de8-52d5-9352-0cfd7e27a5e1';
const LINK = 'b4247b5e-dadc-473b-a79f-0159205c9a92';
const SID = '12d71f2e-5cf4-49df-ad73-4de51cdad6ae';
const PI = '57621b57-547b-4742-8f51-345696d4b3d2';
const RF = '0b8e7c6d-5a4b-4c3d-8e2f-1a0b9c8d7e6f';
const RF2 = '0b8e7c6d-5a4b-4c3d-8e2f-1a0b9c8d7e70';

const MERCHANT: Merchant = {
  id: 'd948f551-b02a-5154-97dc-9d9e39919cf3',
  name: 'Demo Store',
  country: 'CO',
  defaultCurrency: 'USD',
  status: 'active',
  createdAt: '2026-07-01T00:00:00Z',
};

function payment(over: Partial<PosSaleStatus['payment']> = {}): PosSaleStatus['payment'] {
  return {
    id: PI,
    merchant_id: MERCHANT.id,
    amount: 1250,
    currency: 'USD',
    status: 'succeeded',
    failure_code: null,
    amount_refunded: 0,
    amount_captured: 1250,
    payment_link_id: LINK,
    ...over,
  };
}

const refund = (over: Record<string, unknown> = {}) => ({
  id: RF,
  payment_intent_id: PI,
  amount: 1250,
  currency: 'USD',
  status: 'created',
  reason: null,
  failure_code: null,
  created_at: '2026-09-30T10:00:00Z',
  ...over,
});

const res = (s: number, body: unknown) => new Response(JSON.stringify(body), { status: s });
type Handler = (init?: RequestInit) => Response | Promise<Response>;

let calls: Array<{ url: string; init?: RequestInit }>;
function mockFetch(routes: {
  list: Handler[];
  create?: Handler[];
  other?: (url: string) => Response;
}) {
  const q = { list: [...routes.list], create: [...(routes.create ?? [])] };
  const next = (h: Handler[], init?: RequestInit) => (h.length > 1 ? h.shift()! : h[0]!)(init);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith(`/pos/payments/${PI}/refunds`)) return next(q.list, init);
      if (url.endsWith('/refunds') && init?.method === 'POST') return next(q.create, init);
      if (routes.other) return routes.other(url);
      throw new Error(`unexpected ${url}`);
    })
  );
}
const listOf =
  (...refunds: unknown[]): Handler =>
  () =>
    res(200, { refunds, truncated: false });
const posts = () => calls.filter((c) => c.url.endsWith('/refunds') && c.init?.method === 'POST');
const bodyOf = (c: { init?: RequestInit }) => JSON.parse(String(c.init!.body));
const keyOf = (c: { init?: RequestInit }) =>
  (c.init!.headers as Record<string, string>)['idempotency-key'];

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function renderPanel(props: Partial<Parameters<typeof PosRefundPanel>[0]> = {}) {
  return render(
    <PosRefundPanel orgId={ORG} locale="es" payment={payment()} canRefund verified {...props} />
  );
}

describe('PosRefundPanel — recorrido', () => {
  it('devolución total: importe explícito, CSRF, una key; sigue el desenlace hasta «Devuelta»', async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    mockFetch({
      list: [listOf(), listOf(refund()), listOf(refund({ status: 'succeeded' }))],
      create: [() => res(201, refund())],
    });
    renderPanel({ onChanged });

    const summary = await screen.findByTestId('pos-refund-summary');
    expect(summary).toHaveTextContent('Disponible para devolver');
    expect(screen.getByText('Este cobro no tiene devoluciones.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Devolver…' }));
    expect(screen.getByRole('radio', { name: /Todo lo disponible/ })).toBeChecked();
    await user.type(screen.getByLabelText('Motivo (opcional)'), 'Producto devuelto');
    await user.click(screen.getByRole('button', { name: 'Revisar devolución' }));
    expect(screen.getByText(/Vas a devolver .*12[.,]50/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Devolver .*12[.,]50/ }));

    await waitFor(() => expect(posts()).toHaveLength(1));
    const [p] = posts();
    expect(bodyOf(p!)).toEqual({
      payment_intent_id: PI,
      amount: 1250,
      reason: 'Producto devuelto',
    });
    expect((p!.init!.headers as Record<string, string>)['x-fluvia-csrf']).toBe('1');
    expect(keyOf(p!)).toMatch(/^[0-9a-f-]{36}$/);

    const result = await screen.findByTestId('pos-refund-result', {}, { timeout: 5000 });
    await waitFor(() => expect(result).toHaveAttribute('data-status', 'succeeded'), {
      timeout: 5000,
    });
    expect(result).toHaveTextContent('Devolución completada');
    expect(result).toHaveTextContent('La venta sigue cobrada');
    // onChanged: al registrar y UNA vez al cerrarse (no en cada sondeo).
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2));
  });

  it('parcial: valida decimales y el máximo SIN llamar a la API', async () => {
    const user = userEvent.setup();
    mockFetch({ list: [listOf(refund({ status: 'succeeded', amount: 250 }))] });
    renderPanel({ payment: payment({ status: 'partially_refunded', amount_refunded: 250 }) });
    await user.click(await screen.findByRole('button', { name: 'Devolver…' }));
    await user.click(screen.getByRole('radio', { name: 'Una parte' }));
    const input = screen.getByLabelText('Importe a devolver');
    await user.type(input, '10.01');
    await user.click(screen.getByRole('button', { name: 'Revisar devolución' }));
    expect(screen.getByText(/No puedes devolver más de/)).toBeInTheDocument();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    await user.clear(input);
    await user.type(input, '1.234');
    expect(screen.getByText('Esta moneda no admite tantos decimales.')).toBeInTheDocument();
    await user.clear(input);
    await user.type(input, '4,5');
    await user.click(screen.getByRole('button', { name: 'Revisar devolución' }));
    expect(screen.getByText(/Vas a devolver .*4[.,]50/)).toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });

  it('resultado incierto ⇒ reintento con la MISMA key; doble clic ⇒ un solo POST', async () => {
    const user = userEvent.setup();
    let release: (r: Response) => void = () => {};
    mockFetch({
      list: [listOf(), listOf(refund({ status: 'succeeded' }))],
      create: [
        () => Promise.reject(new TypeError('network')),
        () => new Promise<Response>((r) => (release = r)),
      ],
    });
    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Devolver…' }));
    await user.click(screen.getByRole('button', { name: 'Revisar devolución' }));
    await user.click(screen.getByRole('button', { name: /^Devolver / }));

    const alert = await screen.findByText('No sabemos si la devolución se registró');
    expect(alert).toBeInTheDocument();
    // Borrador bloqueado mientras el resultado es incierto.
    expect(screen.getByRole('radio', { name: /Todo lo disponible/ })).toBeDisabled();
    const retry = screen.getByRole('button', { name: 'Reintentar de forma segura' });
    await user.dblClick(retry);
    await waitFor(() => expect(posts()).toHaveLength(2));
    await act(async () => release(res(201, refund())));
    await screen.findByTestId('pos-refund-result');
    expect(posts()).toHaveLength(2);
    expect(keyOf(posts()[0]!)).toBe(keyOf(posts()[1]!));
  });

  it('422 (el cupo cambió) ⇒ error claro, relee las devoluciones y no reintenta solo', async () => {
    const user = userEvent.setup();
    mockFetch({
      list: [listOf(), listOf(refund({ id: RF2, status: 'succeeded', amount: 1000 }))],
      create: [() => res(422, { error: { code: 'refund_amount_exceeds_remaining' } })],
    });
    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Devolver…' }));
    await user.click(screen.getByRole('button', { name: 'Revisar devolución' }));
    await user.click(screen.getByRole('button', { name: /^Devolver / }));
    expect(await screen.findByText(/supera lo que queda por devolver/)).toBeInTheDocument();
    await waitFor(() =>
      expect(calls.filter((c) => c.url.endsWith(`/pos/payments/${PI}/refunds`))).toHaveLength(2)
    );
    expect(posts()).toHaveLength(1);
  });
});

describe('PosRefundPanel — cuándo NO se ofrece devolver', () => {
  it.each([
    ['devolución en curso', [refund({ status: 'processing', amount: 200 })], /devolución en curso/],
    [
      'devolución sin confirmar',
      [refund({ status: 'indeterminate', amount: 200 })],
      /sin confirmar por el proveedor/,
    ],
  ])('%s ⇒ bloqueado', async (_n, refunds, text) => {
    mockFetch({ list: [listOf(...refunds)] });
    renderPanel();
    expect(await screen.findByTestId('pos-refund-block')).toHaveTextContent(text);
    expect(screen.queryByRole('button', { name: 'Devolver…' })).toBeNull();
  });

  it('devuelto por completo ⇒ sin acción, con la lista', async () => {
    mockFetch({ list: [listOf(refund({ status: 'succeeded' }))] });
    renderPanel({ payment: payment({ status: 'refunded', amount_refunded: 1250 }) });
    expect(await screen.findByTestId('pos-refund-block')).toHaveTextContent(
      'devuelto por completo'
    );
    expect(within(screen.getByTestId('pos-refund-list')).getByText('Devuelta')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Devolver…' })).toBeNull();
  });

  it('sin rol, lectura no verificada, ventana truncada o sin capturado ⇒ sin acción', async () => {
    mockFetch({ list: [listOf()] });
    const { unmount } = renderPanel({ canRefund: false });
    expect(await screen.findByTestId('pos-refund-block')).toHaveTextContent(
      'owner, admin o finance'
    );
    unmount();
    renderPanel({ verified: false }).unmount();
    mockFetch({ list: [() => res(200, { refunds: [], truncated: true })] });
    renderPanel();
    expect(await screen.findByTestId('pos-refund-block')).toHaveTextContent('Hay más devoluciones');
    expect(screen.queryByRole('button', { name: 'Devolver…' })).toBeNull();
  });

  it('fallo de lectura ⇒ error con reintento y sin acción de devolver', async () => {
    const user = userEvent.setup();
    mockFetch({ list: [() => res(502, { error: { code: 'upstream_unavailable' } }), listOf()] });
    renderPanel();
    expect(
      await screen.findByText('No pudimos leer las devoluciones de este cobro.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Devolver…' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByRole('button', { name: 'Devolver…' })).toBeInTheDocument();
  });
});

describe('Terminal: devolver NO reabre la venta (invariante #58)', () => {
  it('cobro aprobado ⇒ panel de devolución; tras devolver, ni recuperar ni otro checkout', async () => {
    const user = userEvent.setup();
    let paid = payment();
    const status = () => ({
      session: {
        id: SID,
        status: 'complete',
        expires_at: '2026-09-30T16:00:00Z',
        completed_at: '2026-09-30T15:00:00Z',
        created_at: '2026-09-30T14:00:00Z',
      },
      payment: paid,
    });
    mockFetch({
      list: [listOf(), listOf(refund({ status: 'succeeded' }))],
      create: [
        () => {
          paid = payment({ status: 'refunded', amount_refunded: 1250 });
          return res(201, refund());
        },
      ],
      other: (url) => {
        if (url.includes('/pos/sessions/')) return res(200, status());
        if (url.includes('/pos/sales/'))
          return res(200, {
            link_id: LINK,
            single_charge: true,
            link_status: 'active',
            charge: 'charged',
            charge_payment_intent_id: PI,
            succeeded_count: 1,
            history: 'complete',
            tracking_since: '2026-09-29T15:00:00Z',
            truncated: false,
            checkouts: [],
          });
        throw new Error(`unexpected ${url}`);
      },
    });
    render(
      <PosTerminal
        orgId={ORG}
        locale="es"
        merchants={[MERCHANT]}
        canCharge
        resume={{ sessionId: SID, linkId: LINK }}
      />
    );
    await waitFor(() =>
      expect(screen.getByTestId('pos-phase')).toHaveAttribute('data-phase', 'succeeded')
    );
    await user.click(await screen.findByRole('button', { name: 'Devolver…' }));
    await user.click(screen.getByRole('button', { name: 'Revisar devolución' }));
    await user.click(screen.getByRole('button', { name: /^Devolver / }));
    await waitFor(
      () =>
        expect(screen.getByTestId('pos-refund-result')).toHaveAttribute('data-status', 'succeeded'),
      { timeout: 5000 }
    );
    // El terminal releyó el cobro: sigue «aprobado» (cobrado y devuelto).
    await waitFor(() =>
      expect(screen.getByTestId('pos-refund-block')).toHaveTextContent('por completo')
    );
    expect(screen.getByTestId('pos-phase')).toHaveAttribute('data-phase', 'succeeded');
    expect(screen.queryByTestId('pos-recovery')).toBeNull();
    expect(screen.queryByRole('button', { name: /checkout nuevo|sustituto/i })).toBeNull();
    expect(calls.some((c) => c.url.endsWith('/pos/checkout'))).toBe(false);
    expect(screen.getByRole('button', { name: 'Nuevo cobro' })).toBeInTheDocument();
  });

  it('un cobro no aprobado no muestra devolución', async () => {
    mockFetch({
      list: [listOf()],
      other: (url) => {
        if (url.includes('/pos/sessions/'))
          return res(200, {
            session: {
              id: SID,
              status: 'open',
              expires_at: '2026-09-30T16:00:00Z',
              completed_at: null,
              created_at: '2026-09-30T14:00:00Z',
            },
            payment: payment({ status: 'failed', amount_captured: 0 }),
          });
        return res(502, {});
      },
    });
    render(
      <PosTerminal
        orgId={ORG}
        locale="es"
        merchants={[MERCHANT]}
        canCharge
        resume={{ sessionId: SID, linkId: LINK }}
      />
    );
    await waitFor(() =>
      expect(screen.getByTestId('pos-phase')).toHaveAttribute('data-phase', 'failed')
    );
    expect(screen.queryByTestId('pos-refund')).toBeNull();
  });
});

describe('PosRefundPanel — sin saldo disponible (sandbox)', () => {
  it('cancelada por insufficient_merchant_balance ⇒ explicación clara y el cupo vuelve', async () => {
    const user = userEvent.setup();
    mockFetch({
      list: [
        listOf(),
        listOf(refund({ status: 'canceled', failure_code: 'insufficient_merchant_balance' })),
      ],
      create: [() => res(201, refund())],
    });
    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Devolver…' }));
    await user.click(screen.getByRole('button', { name: 'Revisar devolución' }));
    await user.click(screen.getByRole('button', { name: /^Devolver / }));
    const result = await screen.findByTestId('pos-refund-result');
    await waitFor(() => expect(result).toHaveAttribute('data-status', 'canceled'));
    expect(result).toHaveTextContent('no tiene saldo disponible suficiente');
    expect(result).toHaveTextContent('nada se devolvió');
    // Una cancelada no reserva cupo: se puede volver a intentar más adelante.
    expect(screen.getByRole('button', { name: 'Devolver…' })).toBeInTheDocument();
  });
});
