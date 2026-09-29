import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { PosTerminal } from '../app/lib/pos-terminal';
import { recordAttempt } from '../app/lib/pos-attempts';
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
  window.sessionStorage.clear();
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
    // El checkout anterior sigue pagable: NO se ofrece un checkout sustituto.
    expect(screen.queryByRole('button', { name: /checkout/i })).toBeNull();
    expect(screen.getByTestId('pos-held')).toHaveTextContent('sigue abierto');
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

// ── Incremento 2: rechazo → recuperación, incertidumbre ──────────────────────

const SID2 = '3f0c1a2b-4c5d-4e6f-8a9b-0c1d2e3f4a5b';
const PI2 = '6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d';
const openOk2: Handler = () =>
  res(201, { checkout_session_id: SID2, checkout_url: `http://localhost:3100/c/${SID2}#cs_y` });

function statusFor(
  sid: string,
  pi: string,
  sessionStatus: string,
  intentStatus: string,
  extra = {}
) {
  const s = status(sessionStatus, intentStatus, extra);
  return { session: { ...s.session, id: sid }, payment: { ...s.payment, id: pi } };
}

/** Estado por sesión (la URL dice cuál): el intento 1 queda rechazado. */
function statusBySession(second: unknown) {
  return (url: string) =>
    url.endsWith(SID2)
      ? res(200, second)
      : res(200, statusFor(SID, PI, 'open', 'failed', { failure_code: 'card_declined' }));
}

function mockFetchByUrl(routes: {
  link?: Handler[];
  open?: Handler[];
  status: (url: string) => Response | Promise<Response>;
}) {
  const queues = { link: [...(routes.link ?? [])], open: [...(routes.open ?? [])] };
  const next = (q: Handler[], init?: RequestInit) => (q.length > 1 ? q.shift()! : q[0]!)(init);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/payment-links')) return next(queues.link, init);
      if (url.endsWith('/pos/checkout')) return next(queues.open, init);
      if (url.includes('/pos/sessions/')) return routes.status(url);
      throw new Error(`unexpected ${url}`);
    })
  );
}

describe('PosTerminal — rechazo y recuperación', () => {
  it('rechazo ⇒ recuperar ⇒ checkout nuevo de la MISMA venta: 1 venta, 2 sesiones distintas', async () => {
    mockFetchByUrl({
      link: [linkOk],
      open: [openOk, openOk2],
      status: statusBySession(statusFor(SID2, PI2, 'open', 'requires_payment_method')),
    });
    const { container } = renderPos();
    fireEvent.change(screen.getByLabelText('Importe'), { target: { value: '12.50' } });
    await userEvent.click(screen.getByRole('button', { name: /Cobrar US\$\s12,50/ }));

    // Pantalla de rechazo ANTES de recuperar: código, guía y acción clara.
    expect(await screen.findByText('Pago rechazado')).toBeInTheDocument();
    const recovery = screen.getByTestId('pos-recovery');
    expect(recovery).toHaveTextContent('Recuperar la venta');
    expect(recovery).toHaveTextContent('Es la misma venta: no se crea otra.');
    expect(screen.getByRole('button', { name: 'Nuevo cobro' })).toBeInTheDocument();
    expect((await axe.run(container)).violations).toEqual([]);

    await userEvent.click(screen.getByRole('button', { name: 'Abrir checkout nuevo' }));
    await waitFor(() =>
      expect(screen.getByTestId('pos-phase')).toHaveAttribute('data-phase', 'awaiting_payment')
    );
    expect(posts('/payment-links')).toHaveLength(1);
    expect(posts('/pos/checkout')).toHaveLength(2);
    for (const c of posts('/pos/checkout')) {
      expect(JSON.parse(String(c.init!.body))).toEqual({ payment_link_id: LINK });
    }
    expect(screen.getByRole('link', { name: 'Abrir checkout' })).toHaveAttribute(
      'href',
      `http://localhost:3100/c/${SID2}#cs_y`
    );
    expect(window.location.search).toContain(`session=${SID2}`);
    expect(window.location.search).toContain(`link=${LINK}`);

    // Relación venta→intentos (registrada en esta pestaña), con estado real.
    const attempts = screen.getByTestId('pos-attempts');
    await within(attempts).findByText('Pago rechazado');
    expect(within(attempts).getByText('Esperando al cliente')).toBeInTheDocument();
    expect(
      within(attempts)
        .getByText(/Intento 2/)
        .closest('li')
    ).toHaveAttribute('aria-current', 'step');
    expect(attempts).toHaveTextContent('Abiertos desde esta pestaña');
    expect(window.sessionStorage.getItem(`fluvia.pos.sales.v1:${ORG}`)).not.toContain('cs_');
    expect((await axe.run(container)).violations).toEqual([]);
  });

  it('abrir el checkout nuevo muestra la venta (no un formulario vacío) y enfoca el título', async () => {
    let release!: () => void;
    mockFetchByUrl({
      open: [
        () =>
          new Promise<Response>((r) => {
            release = () =>
              r(
                new Response(
                  JSON.stringify({
                    checkout_session_id: SID2,
                    checkout_url: `http://localhost:3100/c/${SID2}#cs_y`,
                  }),
                  { status: 201 }
                )
              );
          }),
      ],
      status: statusBySession(statusFor(SID2, PI2, 'open', 'created')),
    });
    renderPos({ resume: { sessionId: SID, linkId: LINK } });
    await userEvent.click(await screen.findByRole('button', { name: 'Abrir checkout nuevo' }));
    expect(screen.queryByLabelText('Importe')).toBeNull();
    expect(screen.getByText('Abriendo checkout…')).toBeInTheDocument();
    expect(screen.getByText(/US\$\s12,50/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Estado del cobro' })).toHaveFocus();
    await act(async () => release());
    await waitFor(() =>
      expect(screen.getByTestId('pos-phase')).toHaveAttribute('data-phase', 'awaiting_payment')
    );
  });

  it('expirado ⇒ recuperable para la misma venta', async () => {
    mockFetch({ status: [() => res(200, status('expired', 'requires_payment_method'))] });
    renderPos({ resume: { sessionId: SID, linkId: LINK } });
    expect(await screen.findByText('Checkout expirado')).toBeInTheDocument();
    expect(screen.getByTestId('pos-recovery')).toHaveTextContent('El checkout caducó sin pago');
    expect(screen.getByRole('button', { name: 'Abrir checkout nuevo' })).toBeInTheDocument();
  });

  it('rechazo sin venta conocida (seguido desde la lista) ⇒ lo explica, sin reabrir a ciegas', async () => {
    mockFetch({ status: [() => res(200, status('open', 'failed'))] });
    renderPos({ resume: { sessionId: SID, linkId: null } });
    expect(await screen.findByText('Pago rechazado')).toBeInTheDocument();
    expect(screen.getByTestId('pos-recovery')).toHaveTextContent(
      'la API no permite averiguarla (G3)'
    );
    expect(screen.queryByRole('button', { name: 'Abrir checkout nuevo' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Nuevo cobro' })).toBeInTheDocument();
  });

  it('venta registrada en esta pestaña ⇒ se recupera aunque se siga sin ?link=', async () => {
    recordAttempt(ORG, LINK, SID);
    mockFetch({ open: [openOk2], status: [() => res(200, status('open', 'failed'))] });
    renderPos({ resume: { sessionId: SID, linkId: null } });
    await userEvent.click(await screen.findByRole('button', { name: 'Abrir checkout nuevo' }));
    await waitFor(() => expect(posts('/pos/checkout')).toHaveLength(1));
    expect(JSON.parse(String(posts('/pos/checkout')[0]!.init!.body))).toEqual({
      payment_link_id: LINK,
    });
  });

  it('en proceso ⇒ ni checkout nuevo ni «Nuevo cobro»; explica por qué', async () => {
    mockFetch({ status: [() => res(200, status('open', 'processing'))] });
    renderPos({ resume: { sessionId: SID, linkId: LINK } });
    expect(await screen.findByText('Pago en proceso')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /checkout/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Nuevo cobro' })).toBeNull();
    expect(screen.getByTestId('pos-processing-block')).toHaveTextContent(
      'podría cobrarse dos veces'
    );
    // Tampoco se presenta de nuevo el checkout de un pago en vuelo.
    expect(screen.queryByRole('link', { name: 'Abrir checkout' })).toBeNull();
  });

  it('en proceso con la URL aún en memoria ⇒ no se vuelve a presentar el checkout', async () => {
    mockFetch({
      link: [linkOk],
      open: [openOk],
      status: [() => res(200, status('open', 'processing'))],
    });
    renderPos();
    fireEvent.change(screen.getByLabelText('Importe'), { target: { value: '12.50' } });
    await userEvent.click(screen.getByRole('button', { name: /Cobrar US\$\s12,50/ }));
    expect(await screen.findByText('Pago en proceso')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Abrir checkout' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copiar enlace' })).toBeNull();
  });

  it('estado no reconocido ⇒ sin repetir el cobro', async () => {
    mockFetch({ status: [() => res(200, status('open', 'weird_state'))] });
    renderPos({ resume: { sessionId: SID, linkId: LINK } });
    expect(await screen.findByText('Estado no reconocido')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /checkout/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Nuevo cobro' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Consultar estado' })).toBeInTheDocument();
  });

  it('lectura perdida tras «esperando» ⇒ resultado sin verificar y sin repetir el cobro', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mockFetch({
        status: [() => res(200, status('open', 'created')), () => res(503, {})],
      });
      renderPos({ resume: { sessionId: SID, linkId: LINK } });
      expect(await screen.findByText('Esperando al cliente')).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
      });
      expect(await screen.findByTestId('pos-unverified')).toHaveTextContent(
        'Resultado sin verificar'
      );
      expect(screen.queryByRole('button', { name: /checkout/i })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Nuevo cobro' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Consultar estado' })).toBeInTheDocument();
      expect(screen.getByText(/Último estado leído/)).toBeInTheDocument();
      expect(screen.queryByText(/se actualiza sola\./)).toBeNull();
      expect(screen.queryByText(/abre un checkout nuevo/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('esperando sin URL ⇒ sin checkout sustituto; salida guiada y verificada', async () => {
    mockFetch({
      open: [openOk2],
      status: [
        () => res(200, status('open', 'created')),
        () => res(200, status('open', 'requires_payment_method')),
      ],
    });
    const { container } = renderPos({ resume: { sessionId: SID, linkId: LINK } });
    const held = await screen.findByTestId('pos-held');
    expect(held).toHaveTextContent('El checkout de esta venta sigue abierto');
    expect(held).toHaveTextContent('se cobraría dos veces');
    expect(held).toHaveTextContent('espera a que expire');
    expect(held).toHaveTextContent('«Nuevo cobro» es solo para otra venta distinta');
    // Ningún camino abre un segundo checkout pagable de la misma venta.
    expect(screen.queryByRole('button', { name: /checkout/i })).toBeNull();
    expect(screen.getByRole('button', { name: 'Consultar estado' })).toBeInTheDocument();
    expect((await axe.run(container)).violations).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Consultar estado' }));
    expect(screen.queryByRole('button', { name: /checkout/i })).toBeNull();
    expect(posts('/pos/checkout')).toHaveLength(0);
  });

  it('esperando sin URL ⇒ al expirar (estado verificado) se recupera la misma venta', async () => {
    mockFetch({
      open: [openOk2],
      status: [
        () => res(200, status('open', 'created')),
        () => res(200, status('expired', 'requires_payment_method')),
      ],
    });
    renderPos({ resume: { sessionId: SID, linkId: LINK } });
    expect(await screen.findByTestId('pos-held')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Consultar estado' }));
    expect(await screen.findByText('Checkout expirado')).toBeInTheDocument();
    expect(screen.queryByTestId('pos-held')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Abrir checkout nuevo' }));
    await waitFor(() => expect(posts('/pos/checkout')).toHaveLength(1));
  });
});

// ── Dos checkouts de la misma venta ──────────────────────────────────────────

describe('PosTerminal — dos checkouts de la misma venta', () => {
  /** Intento 1 (SID) en `first`; intento 2 (SID2, el seguido) rechazado. */
  function twoCheckouts(first: unknown) {
    recordAttempt(ORG, LINK, SID);
    recordAttempt(ORG, LINK, SID2);
    mockFetchByUrl({
      open: [openOk],
      status: (url) =>
        url.endsWith(SID2)
          ? res(200, statusFor(SID2, PI2, 'open', 'failed', { failure_code: 'card_declined' }))
          : res(200, first),
    });
    renderPos({ resume: { sessionId: SID2, linkId: LINK } });
  }

  it('el otro checkout sigue pagable ⇒ el rechazo del actual NO permite abrir otro', async () => {
    twoCheckouts(statusFor(SID, PI, 'open', 'requires_payment_method'));
    await waitFor(() =>
      expect(screen.getByTestId('pos-phase')).toHaveAttribute('data-phase', 'failed')
    );
    await within(screen.getByTestId('pos-attempts')).findByText('Esperando al cliente');
    expect(screen.getByTestId('pos-recovery')).toHaveTextContent(
      'Otro checkout de esta venta sigue abierto'
    );
    expect(screen.queryByRole('button', { name: 'Abrir checkout nuevo' })).toBeNull();
    expect(posts('/pos/checkout')).toHaveLength(0);
  });

  it('el otro checkout ya cobró ⇒ la venta está cobrada; no se ofrece recobrar', async () => {
    twoCheckouts(statusFor(SID, PI, 'completed', 'succeeded'));
    await waitFor(() =>
      expect(screen.getByTestId('pos-phase')).toHaveAttribute('data-phase', 'failed')
    );
    await within(screen.getByTestId('pos-attempts')).findByText('Pago aprobado');
    expect(screen.getByTestId('pos-recovery')).toHaveTextContent('la venta está cobrada');
    expect(screen.queryByRole('button', { name: 'Abrir checkout nuevo' })).toBeNull();
  });

  it('el otro checkout no se pudo leer ⇒ sin verificar, no se reabre', async () => {
    recordAttempt(ORG, LINK, SID);
    recordAttempt(ORG, LINK, SID2);
    mockFetchByUrl({
      status: (url) =>
        url.endsWith(SID2)
          ? res(200, statusFor(SID2, PI2, 'open', 'failed'))
          : res(503, { error: { code: 'upstream_unavailable' } }),
    });
    renderPos({ resume: { sessionId: SID2, linkId: LINK } });
    await waitFor(() =>
      expect(screen.getByTestId('pos-phase')).toHaveAttribute('data-phase', 'failed')
    );
    await within(screen.getByTestId('pos-attempts')).findByText('sin consultar');
    expect(screen.queryByRole('button', { name: 'Abrir checkout nuevo' })).toBeNull();
  });

  it('el otro checkout expiró ⇒ la recuperación es segura y se ofrece', async () => {
    twoCheckouts(statusFor(SID, PI, 'expired', 'requires_payment_method'));
    await waitFor(() =>
      expect(screen.getByTestId('pos-phase')).toHaveAttribute('data-phase', 'failed')
    );
    await within(screen.getByTestId('pos-attempts')).findByText('Checkout expirado');
    await userEvent.click(await screen.findByRole('button', { name: 'Abrir checkout nuevo' }));
    await waitFor(() => expect(posts('/pos/checkout')).toHaveLength(1));
  });
});
