import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { PosRefundPanel } from '../app/lib/pos-refund';
import type { PosSaleStatus } from '../app/lib/pos-contract';

/**
 * Devolución del POS — estados de carga, error, sesión caducada y sin acceso,
 * teclado/foco y accesibilidad (axe). Regla transversal: con una lectura que
 * NO es fresca y correcta se muestra lo que hay, pero nunca se ofrece devolver.
 */

const ORG = '1bfed2e0-1de8-52d5-9352-0cfd7e27a5e1';
const LINK = 'b4247b5e-dadc-473b-a79f-0159205c9a92';
const PI = '57621b57-547b-4742-8f51-345696d4b3d2';
const RF = '0b8e7c6d-5a4b-4c3d-8e2f-1a0b9c8d7e6f';

const payment = (over: Partial<PosSaleStatus['payment']> = {}): PosSaleStatus['payment'] => ({
  id: PI,
  merchant_id: 'd948f551-b02a-5154-97dc-9d9e39919cf3',
  amount: 1250,
  currency: 'USD',
  status: 'succeeded',
  failure_code: null,
  amount_refunded: 0,
  amount_captured: 1250,
  payment_link_id: LINK,
  ...over,
});
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
type Handler = () => Response | Promise<Response>;

let calls: Array<{ url: string; init?: RequestInit }>;
function mockFetch(list: Handler[], create: Handler[] = []) {
  const q = { list: [...list], create: [...create] };
  const next = (h: Handler[]) => (h.length > 1 ? h.shift()! : h[0]!)();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith(`/pos/payments/${PI}/refunds`)) return next(q.list);
      if (url.endsWith('/refunds') && init?.method === 'POST') return next(q.create);
      throw new Error(`unexpected ${url}`);
    })
  );
}
const listOf =
  (...refunds: unknown[]): Handler =>
  () =>
    res(200, { refunds, truncated: false });
const reads = () => calls.filter((c) => c.url.endsWith(`/pos/payments/${PI}/refunds`)).length;

async function expectNoAxeViolations(container: HTMLElement) {
  const r = await axe.run(container, { rules: { region: { enabled: false } } });
  expect(r.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const renderPanel = (props: Partial<Parameters<typeof PosRefundPanel>[0]> = {}) =>
  render(
    <PosRefundPanel orgId={ORG} locale="es" payment={payment()} canRefund verified {...props} />
  );

describe('carga', () => {
  it('muestra «Cargando…» con aria-busy y sin acción hasta leer', async () => {
    let release: (r: Response) => void = () => {};
    mockFetch([() => new Promise<Response>((r) => (release = r))]);
    renderPanel();
    expect(screen.getByTestId('pos-refund-loading')).toHaveAttribute('role', 'status');
    expect(screen.getByTestId('pos-refund')).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByRole('button', { name: 'Devolver…' })).toBeNull();
    await act(async () => release(res(200, { refunds: [], truncated: false })));
    expect(await screen.findByRole('button', { name: 'Devolver…' })).toBeInTheDocument();
    expect(screen.getByTestId('pos-refund')).toHaveAttribute('aria-busy', 'false');
  });
});

describe('error de lectura', () => {
  it('con datos previos: los conserva marcados como desactualizados y retira la acción', async () => {
    const user = userEvent.setup();
    mockFetch([
      listOf(refund({ status: 'succeeded', amount: 250 })),
      () => res(502, { error: { code: 'upstream_unavailable' } }),
      listOf(refund({ status: 'succeeded', amount: 250 })),
    ]);
    const { rerender } = renderPanel({
      payment: payment({ status: 'partially_refunded', amount_refunded: 250 }),
    });
    expect(await screen.findByRole('button', { name: 'Devolver…' })).toBeInTheDocument();
    // Cambia el cobro leído ⇒ relectura, que falla.
    rerender(
      <PosRefundPanel
        orgId={ORG}
        locale="es"
        payment={payment({ status: 'partially_refunded', amount_refunded: 251 })}
        canRefund
        verified
      />
    );
    const alert = await screen.findByTestId('pos-refund-read-error');
    expect(alert).toHaveTextContent(/puede estar desactualizado/);
    expect(screen.getByTestId('pos-refund-summary')).toHaveClass('pos-stale');
    expect(screen.getByTestId('pos-refund-list')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Devolver…' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByRole('button', { name: 'Devolver…' })).toBeInTheDocument();
    expect(screen.queryByTestId('pos-refund-read-error')).toBeNull();
  });
});

describe('sesión caducada y sin acceso', () => {
  it('401 al leer ⇒ aviso con enlace a iniciar sesión, sin acción', async () => {
    mockFetch([() => res(401, { ok: false, error: { code: 'invalid_session' } })]);
    renderPanel();
    const auth = await screen.findByTestId('pos-refund-auth');
    expect(auth).toHaveTextContent('Tu sesión caducó.');
    expect(screen.getByRole('link', { name: 'Vuelve a iniciar sesión' })).toHaveAttribute(
      'href',
      '/login'
    );
    expect(screen.queryByRole('button', { name: 'Devolver…' })).toBeNull();
  });

  it('401 al registrar ⇒ «no se registró» + iniciar sesión; no reintenta ni relee', async () => {
    const user = userEvent.setup();
    mockFetch([listOf()], [() => res(401, { ok: false, error: { code: 'invalid_session' } })]);
    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Devolver…' }));
    await user.click(screen.getByRole('button', { name: 'Revisar devolución' }));
    await user.click(screen.getByRole('button', { name: /^Devolver / }));
    const auth = await screen.findByTestId('pos-refund-auth');
    expect(auth).toHaveTextContent('La devolución no se registró.');
    expect(screen.getByRole('link', { name: 'Vuelve a iniciar sesión' })).toBeInTheDocument();
    expect(screen.getByTestId('pos-refund-failed')).toHaveFocus();
    expect(reads()).toBe(1);
  });

  it('403/404 al leer ⇒ sin acceso', async () => {
    mockFetch([() => res(404, { ok: false, error: { code: 'not_found' } })]);
    renderPanel();
    expect(await screen.findByTestId('pos-refund-forbidden')).toHaveTextContent('No tienes acceso');
    expect(screen.queryByRole('button', { name: 'Devolver…' })).toBeNull();
  });

  it('401 durante el seguimiento ⇒ deja de consultar', async () => {
    const user = userEvent.setup();
    mockFetch(
      [listOf(), () => res(401, { ok: false, error: { code: 'invalid_session' } })],
      [() => res(201, refund())]
    );
    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Devolver…' }));
    await user.click(screen.getByRole('button', { name: 'Revisar devolución' }));
    await user.click(screen.getByRole('button', { name: /^Devolver / }));
    await screen.findByTestId('pos-refund-auth');
    const n = reads();
    await new Promise((r) => setTimeout(r, 2_300));
    expect(reads()).toBe(n);
  });
});

describe('desenlace sin confirmar', () => {
  it('indeterminada ⇒ aviso honesto + «Consultar devoluciones»; bloquea otra devolución', async () => {
    const user = userEvent.setup();
    mockFetch([listOf(), listOf(refund({ status: 'indeterminate' }))], [() => res(201, refund())]);
    const { container } = renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Devolver…' }));
    await user.click(screen.getByRole('button', { name: 'Revisar devolución' }));
    await user.click(screen.getByRole('button', { name: /^Devolver / }));
    const result = await screen.findByTestId('pos-refund-result');
    await waitFor(() => expect(result).toHaveAttribute('data-status', 'indeterminate'));
    expect(result).toHaveTextContent('no la repitas');
    expect(screen.getByRole('button', { name: 'Consultar devoluciones' })).toBeInTheDocument();
    expect(screen.getByTestId('pos-refund-block')).toHaveTextContent('sin confirmar');
    expect(screen.queryByRole('button', { name: 'Devolver…' })).toBeNull();
    await expectNoAxeViolations(container);
  });

  it('sin desenlace tras el tope de consultas ⇒ «aún no conocemos el desenlace»', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mockFetch([listOf(), listOf(refund({ status: 'processing' }))], [() => res(201, refund())]);
    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Devolver…' }));
    await user.click(screen.getByRole('button', { name: 'Revisar devolución' }));
    await user.click(screen.getByRole('button', { name: /^Devolver / }));
    await screen.findByTestId('pos-refund-result');
    for (let i = 0; i < 25; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_100);
      });
    }
    expect(await screen.findByTestId('pos-refund-stalled')).toBeInTheDocument();
    const n = reads();
    await user.click(screen.getByRole('button', { name: 'Consultar devoluciones' }));
    await waitFor(() => expect(reads()).toBeGreaterThan(n));
  });
});

describe('teclado, foco y accesibilidad', () => {
  it('abrir ⇒ foco en la primera opción; Escape cancela y devuelve el foco', async () => {
    const user = userEvent.setup();
    mockFetch([listOf()]);
    const { container } = renderPanel();
    const start = await screen.findByRole('button', { name: 'Devolver…' });
    start.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('radio', { name: /Todo lo disponible/ })).toHaveFocus();
    await expectNoAxeViolations(container);
    // Flecha ⇒ «Una parte» y el foco va al importe.
    await user.keyboard('{ArrowDown}');
    await waitFor(() => expect(screen.getByLabelText('Importe a devolver')).toHaveFocus());
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('radio')).toBeNull();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Devolver…' })).toHaveFocus());
  });

  it('solo teclado: parcial → revisar (Enter) → confirmación enfocada → devolver', async () => {
    const user = userEvent.setup();
    mockFetch(
      [listOf(), listOf(refund({ status: 'succeeded', amount: 500 }))],
      [() => res(201, refund({ amount: 500 }))]
    );
    const { container } = renderPanel();
    (await screen.findByRole('button', { name: 'Devolver…' })).focus();
    await user.keyboard('{Enter}');
    await user.keyboard('{ArrowDown}');
    await waitFor(() => expect(screen.getByLabelText('Importe a devolver')).toHaveFocus());
    await user.keyboard('5{Enter}');
    const title = screen.getByText('Confirma la devolución');
    expect(title).toHaveFocus();
    await expectNoAxeViolations(container);
    await user.tab();
    expect(screen.getByRole('button', { name: /^Devolver .*5[.,]00/ })).toHaveFocus();
    await user.keyboard('{Enter}');
    const result = await screen.findByTestId('pos-refund-result');
    expect(result).toHaveFocus();
    await waitFor(() => expect(result).toHaveAttribute('data-status', 'succeeded'));
    await expectNoAxeViolations(container);
  });

  it('importe inválido ⇒ error asociado (aria-describedby) y foco en el campo', async () => {
    const user = userEvent.setup();
    mockFetch([listOf()]);
    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Devolver…' }));
    await user.click(screen.getByRole('radio', { name: 'Una parte' }));
    await user.click(screen.getByRole('button', { name: 'Revisar devolución' }));
    const input = screen.getByLabelText('Importe a devolver');
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription(/Introduce el importe a devolver/);
  });

  it('resultado incierto enfocado y sin violaciones axe', async () => {
    const user = userEvent.setup();
    mockFetch([listOf()], [() => res(502, { error: { code: 'upstream_unavailable' } })]);
    const { container } = renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Devolver…' }));
    await user.click(screen.getByRole('button', { name: 'Revisar devolución' }));
    await user.click(screen.getByRole('button', { name: /^Devolver / }));
    const alert = await screen.findByTestId('pos-refund-uncertain');
    expect(alert).toHaveFocus();
    // Escape NO descarta un resultado incierto (la key debe conservarse).
    await user.keyboard('{Escape}');
    expect(screen.getByTestId('pos-refund-uncertain')).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('inglés: textos traducidos', async () => {
    mockFetch([listOf()]);
    render(<PosRefundPanel orgId={ORG} locale="en" payment={payment()} canRefund verified />);
    expect(await screen.findByRole('button', { name: 'Refund…' })).toBeInTheDocument();
    expect(screen.getByText('Available to refund')).toBeInTheDocument();
  });
});
