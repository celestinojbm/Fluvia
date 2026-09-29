import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { PosTerminal } from '../app/lib/pos-terminal';
import type { Merchant } from '../app/lib/api';

/**
 * POS sandbox — terminal (jsdom + axe). Cubre el recorrido y sus garantías:
 * un solo POST ante doble envío, misma Idempotency-Key al reintentar tras un
 * resultado incierto, apertura incierta SIN reintento automático, estados
 * vacíos/rol y fases derivadas de la API.
 */

const ORG = '1bfed2e0-1de8-52d5-9352-0cfd7e27a5e1';
const LINK = 'b4247b5e-dadc-473b-a79f-0159205c9a92';
const SID = '12d71f2e-5cf4-49df-ad73-4de51cdad6ae';
const PI = '57621b57-547b-4742-8f51-345696d4b3d2';

const MERCHANT: Merchant = {
  id: 'd948f551-b02a-5154-97dc-9d9e39919cf3',
  name: 'Demo Store',
  country: 'CO',
  defaultCurrency: 'USD',
  status: 'active',
  createdAt: '2026-07-01T00:00:00Z',
};

function status(sessionStatus: string, intentStatus: string, extra: Record<string, unknown> = {}) {
  return {
    session: {
      id: SID,
      status: sessionStatus,
      expires_at: '2026-09-30T16:00:00Z',
      completed_at: null,
      created_at: '2026-09-29T16:00:00Z',
    },
    payment: {
      id: PI,
      merchant_id: MERCHANT.id,
      amount: 1250,
      currency: 'USD',
      status: intentStatus,
      failure_code: null,
      amount_refunded: 0,
      ...extra,
    },
  };
}

type Handler = (init?: RequestInit) => Promise<Response> | Response;
const res = (s: number, body: unknown) => new Response(JSON.stringify(body), { status: s });

let calls: Array<{ url: string; init?: RequestInit }>;
function mockFetch(routes: { link?: Handler[]; open?: Handler[]; status?: Handler[] }) {
  const queues = {
    link: [...(routes.link ?? [])],
    open: [...(routes.open ?? [])],
    status: [...(routes.status ?? [])],
  };
  const next = (q: Handler[], init?: RequestInit) => (q.length > 1 ? q.shift()! : q[0]!)(init);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/payment-links')) return next(queues.link, init);
      if (url.endsWith('/pos/checkout')) return next(queues.open, init);
      if (url.includes('/pos/sessions/')) return next(queues.status, init);
      throw new Error(`unexpected ${url}`);
    })
  );
}

const linkOk: Handler = () => res(201, { id: LINK, status: 'active' });
const openOk: Handler = () =>
  res(201, { checkout_session_id: SID, checkout_url: `http://localhost:3100/c/${SID}#cs_x` });

const posts = (suffix: string) =>
  calls.filter((c) => c.url.endsWith(suffix) && c.init?.method === 'POST');

function renderPos(props: Partial<React.ComponentProps<typeof PosTerminal>> = {}) {
  return render(
    <PosTerminal orgId={ORG} locale="es" merchants={[MERCHANT]} canCharge {...props} />
  );
}

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PosTerminal — entrada', () => {
  it('formulario accesible (axe), foco en importe y vista previa del cobro', async () => {
    mockFetch({});
    const { container } = renderPos();
    expect(screen.getByLabelText('Importe')).toHaveFocus();
    await userEvent.type(screen.getByLabelText('Importe'), '12.50');
    expect(screen.getByText(/Se cobrará US\$\s12,50/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Cobrar US\$\s12,50/ })).toBeEnabled();
    const r = await axe.run(container);
    expect(r.violations).toEqual([]);
  });

  it('importe inválido: error accesible y NINGUNA llamada', async () => {
    mockFetch({});
    renderPos();
    await userEvent.type(screen.getByLabelText('Importe'), '1.005');
    await userEvent.click(screen.getByRole('button', { name: 'Cobrar' }));
    expect(screen.getByText('Esta moneda no admite tantos decimales.')).toBeInTheDocument();
    expect(screen.getByLabelText('Importe')).toHaveAttribute('aria-invalid', 'true');
    expect(calls).toHaveLength(0);
  });

  it('sin rol de cobro: explica y no ofrece formulario', () => {
    mockFetch({});
    renderPos({ canCharge: false });
    expect(screen.getByRole('heading', { name: 'Tu rol no puede cobrar' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Importe')).toBeNull();
  });

  it('sin comercios activos: estado vacío con acción', () => {
    mockFetch({});
    renderPos({ merchants: [] });
    expect(screen.getByRole('link', { name: 'Configurar comercio' })).toHaveAttribute(
      'href',
      '/onboarding'
    );
  });
});

describe('PosTerminal — recorrido', () => {
  it('doble envío ⇒ UN solo POST de creación; luego checkout y seguimiento', async () => {
    mockFetch({
      link: [linkOk],
      open: [openOk],
      status: [() => res(200, status('open', 'created'))],
    });
    renderPos();
    fireEvent.change(screen.getByLabelText('Importe'), { target: { value: '12.50' } });
    const form = screen.getByRole('button', { name: /Cobrar US\$\s12,50/ }).closest('form')!;
    await act(async () => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    await screen.findByText('Esperando al cliente');
    expect(posts('/payment-links')).toHaveLength(1);
    expect(posts('/pos/checkout')).toHaveLength(1);
    const body = JSON.parse(String(posts('/payment-links')[0]!.init!.body));
    expect(body).toEqual({ merchant_id: MERCHANT.id, amount: 1250, currency: 'USD' });
    const headers = posts('/payment-links')[0]!.init!.headers as Record<string, string>;
    expect(headers['x-fluvia-csrf']).toBe('1');
    expect(headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    const open = screen.getByRole('link', { name: 'Abrir checkout' });
    expect(open).toHaveAttribute('href', `http://localhost:3100/c/${SID}#cs_x`);
    expect(open).toHaveAttribute('rel', 'noopener noreferrer');
    // El secreto no se pinta en pantalla (solo va en el href).
    expect(screen.queryByText(/cs_x/)).toBeNull();
    expect(window.location.search).toContain(`session=${SID}`);
    expect(window.location.search).not.toContain('cs_x');
  });

  it('pago aprobado: estado verificado por la API y acciones siguientes', async () => {
    mockFetch({
      link: [linkOk],
      open: [openOk],
      status: [() => res(200, status('completed', 'succeeded'))],
    });
    renderPos();
    fireEvent.change(screen.getByLabelText('Importe'), { target: { value: '12.50' } });
    await userEvent.click(screen.getByRole('button', { name: /Cobrar US\$\s12,50/ }));
    expect(await screen.findByText('Pago aprobado')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ver detalle del pago' })).toHaveAttribute(
      'href',
      `/o/${ORG}/payments/${PI}`
    );
    expect(screen.queryByRole('link', { name: 'Abrir checkout' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Nuevo cobro' }));
    expect(screen.getByLabelText('Importe')).toHaveValue('');
  });

  it('rechazo: muestra código y permite abrir un checkout nuevo para la MISMA venta', async () => {
    mockFetch({
      link: [linkOk],
      open: [openOk],
      status: [() => res(200, status('open', 'failed', { failure_code: 'card_declined' }))],
    });
    renderPos();
    fireEvent.change(screen.getByLabelText('Importe'), { target: { value: '12.50' } });
    await userEvent.click(screen.getByRole('button', { name: /Cobrar US\$\s12,50/ }));
    expect(await screen.findByText('Pago rechazado')).toBeInTheDocument();
    expect(screen.getByText('Código: card_declined')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Abrir checkout nuevo' }));
    await waitFor(() => expect(posts('/pos/checkout')).toHaveLength(2));
    expect(posts('/payment-links')).toHaveLength(1);
    expect(JSON.parse(String(posts('/pos/checkout')[1]!.init!.body))).toEqual({
      payment_link_id: LINK,
    });
  });

  it('creación incierta ⇒ reintento seguro con la MISMA Idempotency-Key', async () => {
    mockFetch({
      link: [() => Promise.reject(new TypeError('network')), linkOk],
      open: [openOk],
      status: [() => res(200, status('open', 'created'))],
    });
    renderPos();
    fireEvent.change(screen.getByLabelText('Importe'), { target: { value: '12.50' } });
    await userEvent.click(screen.getByRole('button', { name: /Cobrar US\$\s12,50/ }));
    expect(await screen.findByText('No sabemos si la venta se creó')).toBeInTheDocument();
    expect(screen.getByLabelText('Importe')).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Reintentar de forma segura' }));
    await screen.findByText('Esperando al cliente');
    const keys = posts('/payment-links').map(
      (c) => (c.init!.headers as Record<string, string>)['idempotency-key']
    );
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('borrador distinto ⇒ Idempotency-Key distinta', async () => {
    mockFetch({ link: [() => res(403, { error: { code: 'insufficient_permissions' } })] });
    renderPos();
    fireEvent.change(screen.getByLabelText('Importe'), { target: { value: '12.50' } });
    await userEvent.click(screen.getByRole('button', { name: /Cobrar US\$\s12,50/ }));
    expect(await screen.findByText('Tu rol no permite esta acción.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Importe'), { target: { value: '13' } });
    await userEvent.click(screen.getByRole('button', { name: /Cobrar US\$\s13,00/ }));
    await waitFor(() => expect(posts('/payment-links')).toHaveLength(2));
    const keys = posts('/payment-links').map(
      (c) => (c.init!.headers as Record<string, string>)['idempotency-key']
    );
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('apertura incierta ⇒ SIN reintento automático; solo por acción explícita', async () => {
    mockFetch({
      link: [linkOk],
      open: [() => res(502, { ok: false, error: { code: 'checkout_open_uncertain' } }), openOk],
      status: [() => res(200, status('open', 'created'))],
    });
    renderPos();
    fireEvent.change(screen.getByLabelText('Importe'), { target: { value: '12.50' } });
    await userEvent.click(screen.getByRole('button', { name: /Cobrar US\$\s12,50/ }));
    expect(await screen.findByText('No sabemos si el checkout se abrió')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveFocus();
    expect(posts('/pos/checkout')).toHaveLength(1);
    await userEvent.click(
      screen.getByRole('button', { name: 'Abrir un checkout nuevo para esta venta' })
    );
    await screen.findByText('Esperando al cliente');
    expect(posts('/pos/checkout')).toHaveLength(2);
    expect(posts('/payment-links')).toHaveLength(1);
  });

  it('link no disponible ⇒ error definitivo sin opción de reabrir', async () => {
    mockFetch({ link: [linkOk], open: [() => res(409, { error: { code: 'link_unavailable' } })] });
    renderPos();
    fireEvent.change(screen.getByLabelText('Importe'), { target: { value: '12.50' } });
    await userEvent.click(screen.getByRole('button', { name: /Cobrar US\$\s12,50/ }));
    expect(
      await screen.findByText('El enlace de la venta ya no está activo. Crea un cobro nuevo.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Abrir un checkout nuevo/ })).toBeNull();
  });
});

describe('PosTerminal — reanudación y lectura', () => {
  it('reanuda por ?session: sin URL de pago (secreto no guardado) pero con estado real', async () => {
    mockFetch({ status: [() => res(200, status('open', 'created'))] });
    renderPos({ resume: { sessionId: SID, linkId: LINK } });
    expect(await screen.findByText('Esperando al cliente')).toBeInTheDocument();
    expect(screen.getByText(/no se conserva al recargar/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Abrir checkout nuevo' })).toBeInTheDocument();
  });

  it('404 al consultar ⇒ «no encontrado», nunca un estado inventado', async () => {
    mockFetch({ status: [() => res(404, { error: { code: 'not_found' } })] });
    renderPos({ resume: { sessionId: SID, linkId: null } });
    expect(
      await screen.findByText('No encontramos este cobro en la organización.')
    ).toBeInTheDocument();
    expect(screen.getByTestId('pos-phase')).toHaveAttribute('data-phase', 'loading');
  });

  it('401 al consultar ⇒ invita a iniciar sesión', async () => {
    mockFetch({ status: [() => res(401, {})] });
    renderPos({ resume: { sessionId: SID, linkId: null } });
    expect(await screen.findByRole('link', { name: 'Iniciar sesión' })).toHaveAttribute(
      'href',
      '/login'
    );
  });

  it('en proceso: advierte no cobrar de nuevo y no ofrece reabrir', async () => {
    mockFetch({ status: [() => res(200, status('open', 'processing'))] });
    renderPos({ resume: { sessionId: SID, linkId: LINK } });
    expect(await screen.findByText('Pago en proceso')).toBeInTheDocument();
    expect(screen.getByText(/No cobres de nuevo/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Abrir checkout nuevo' })).toBeNull();
  });
});
