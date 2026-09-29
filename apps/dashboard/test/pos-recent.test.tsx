import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import {
  fetchRecentCharges,
  joinRecentCharges,
  RECENT_WINDOW,
  type RecentChargesResult,
} from '../app/lib/pos-reads';
import { filterRecent, parseRecent, PosRecentCharges } from '../app/lib/pos-recent';

/**
 * POS — cobros recientes: unión REAL sesión↔intent por `payment_intent_id`
 * (whitelist), ventana acotada por la API y declarada, filtros SOLO sobre esa
 * ventana, estados carga/vacío/error/sesión caducada/recarga distintos, BFF
 * acotado a la org de la ruta, y refresco sin recargar la página.
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
import { GET as recentGET } from '../app/api/orgs/[orgId]/pos/recent/route';

const ORG = '1bfed2e0-1de8-52d5-9352-0cfd7e27a5e1';
const OTHER_ORG = '2c0fe3f1-2ef9-43e6-a463-1d0e8f38b6f2';
const M1 = 'd948f551-b02a-5154-97dc-9d9e39919cf3';
const M2 = 'a1b2c3d4-0000-4000-8000-000000000002';
const MERCHANTS = [
  { id: M1, name: 'Demo Store' },
  { id: M2, name: 'Segunda Tienda' },
];

const uid = (prefix: string, n: number) =>
  `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sid = (n: number) => uid('00000000', n);
const pid = (n: number) => uid('11111111', n);

function session(n: number, status = 'open', intentId = pid(n)) {
  return {
    id: sid(n),
    object: 'checkout_session',
    payment_intent_id: intentId,
    customer_id: null,
    status,
    url: `http://localhost:3100/c/${sid(n)}`,
    success_url: null,
    cancel_url: null,
    expires_at: '2026-09-30T00:00:00Z',
    completed_at: null,
    created_at: `2026-09-29T10:${String(n % 60).padStart(2, '0')}:${String(Math.floor(n / 60)).padStart(2, '0')}Z`,
  };
}
function intent(n: number, status: string, merchant = M1, amount = 1250) {
  return {
    id: pid(n),
    merchant_id: merchant,
    amount,
    currency: 'USD',
    status,
    capture_method: 'automatic',
    amount_captured: 0,
    amount_refunded: 0,
    failure_code: null,
    created_at: '2026-09-29T10:00:00Z',
  };
}

describe('joinRecentCharges', () => {
  it('une por payment_intent_id, ordena desc, whitelist y declara la ventana', () => {
    const sessions = Array.from({ length: 14 }, (_, i) => session(i));
    const r = joinRecentCharges(sessions, [intent(13, 'succeeded'), intent(12, 'failed')]);
    expect(r.rows).toHaveLength(14);
    expect(r.rows[0]!.session.id).toBe(sid(13));
    expect(r.rows[0]!.payment?.status).toBe('succeeded');
    expect(r.rows[1]!.payment?.status).toBe('failed');
    // Intent fuera de la ventana leída: null, jamás un pago inventado.
    expect(r.rows[2]!.payment).toBeNull();
    // Sin `url` de sesión ni campos no listados.
    expect(Object.keys(r.rows[0]!.session).sort()).toEqual([
      'created_at',
      'expires_at',
      'id',
      'status',
    ]);
    expect(JSON.stringify(r)).not.toContain('localhost:3100');
    expect(r.window).toEqual({ limit: RECENT_WINDOW, returned: 14, truncated: false });
  });

  it('una ventana llena se marca truncada', () => {
    const sessions = Array.from({ length: RECENT_WINDOW }, (_, i) => session(i));
    expect(joinRecentCharges(sessions, []).window.truncated).toBe(true);
  });

  it('descarta filas malformadas en lugar de inventar', () => {
    const r = joinRecentCharges(
      [{ id: 'x' }, session(1)],
      [{ id: pid(1), merchant_id: M1, amount: '1250', currency: 'USD', status: 'x' }]
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.payment).toBeNull();
  });
});

describe('fetchRecentCharges', () => {
  const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });

  it('lee la ventana máxima por el plano de sesión con Bearer', async () => {
    const f = vi.fn((url: string) =>
      Promise.resolve(
        url.includes('checkout_sessions') ? ok([session(1)]) : ok([intent(1, 'created')])
      )
    );
    const r = await fetchRecentCharges({
      apiBase: 'http://api',
      token: 't',
      orgId: ORG,
      fetchImpl: f as never,
    });
    expect(r.ok).toBe(true);
    expect(f.mock.calls.map((c) => c[0])).toEqual([
      `http://api/v1/organizations/${ORG}/checkout_sessions?limit=100`,
      `http://api/v1/organizations/${ORG}/payment_intents?limit=100`,
    ]);
    expect((f.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toEqual({
      authorization: 'Bearer t',
    });
  });

  it('distingue sesión caducada, sin acceso y no disponible (nunca «vacío»)', async () => {
    const cases: Array<[() => Promise<Response>, string]> = [
      [() => Promise.resolve(new Response('{}', { status: 401 })), 'auth'],
      [() => Promise.resolve(new Response('{}', { status: 403 })), 'forbidden'],
      [() => Promise.resolve(new Response('{}', { status: 404 })), 'forbidden'],
      [() => Promise.reject(new Error('down')), 'unavailable'],
      [() => Promise.resolve(new Response('{}', { status: 500 })), 'unavailable'],
      [() => Promise.resolve(new Response('{"nodata":1}', { status: 200 })), 'unavailable'],
    ];
    for (const [bad, reason] of cases) {
      const f = vi.fn((url: string) =>
        url.includes('payment_intents') ? bad() : Promise.resolve(ok([]))
      );
      expect(
        await fetchRecentCharges({
          apiBase: 'http://api',
          token: 't',
          orgId: ORG,
          fetchImpl: f as never,
        })
      ).toEqual({ ok: false, reason });
    }
  });
});

describe('BFF GET /api/orgs/:orgId/pos/recent', () => {
  const ctx = (orgId: string) => ({ params: Promise.resolve({ orgId }) });
  const req = (orgId: string) => new Request(`http://dashboard.local/api/orgs/${orgId}/pos/recent`);
  beforeEach(() => {
    cookieState.value = 'session-token-test';
  });
  afterEach(() => vi.unstubAllGlobals());

  it('sin sesión ⇒ 401 sin tocar la API', async () => {
    cookieState.value = null;
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const r = await recentGET(req(ORG), ctx(ORG));
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ ok: false, error: { code: 'invalid_session' } });
    expect(f).not.toHaveBeenCalled();
  });

  it('org no-UUID ⇒ 400 sin tocar la API', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    expect((await recentGET(req('../x'), ctx('../x'))).status).toBe(400);
    expect(f).not.toHaveBeenCalled();
  });

  it('solo consulta la org de la RUTA con el token de la cookie; responde whitelist', async () => {
    const f = vi.fn((url: string) =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: url.includes('checkout_sessions') ? [session(1)] : [intent(1, 'failed')],
          }),
          { status: 200 }
        )
      )
    );
    vi.stubGlobal('fetch', f);
    const r = await recentGET(req(ORG), ctx(ORG));
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    for (const [url, init] of f.mock.calls as unknown as Array<[string, RequestInit]>) {
      expect(url).toContain(`/v1/organizations/${ORG}/`);
      expect(url).not.toContain(OTHER_ORG);
      expect(init.headers).toEqual({ authorization: 'Bearer session-token-test' });
    }
    const body = await r.json();
    expect(body.rows[0].payment.status).toBe('failed');
    expect(JSON.stringify(body)).not.toContain('/c/');
  });

  it('otra org (RLS/membresía ⇒ 404/403) se responde 404, nunca lista vacía', async () => {
    for (const s of [403, 404]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(() => Promise.resolve(new Response('{}', { status: s })))
      );
      const r = await recentGET(req(OTHER_ORG), ctx(OTHER_ORG));
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ ok: false, error: { code: 'not_found' } });
    }
  });

  it('401 de la API ⇒ 401; caída ⇒ 502', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('{}', { status: 401 })))
    );
    expect((await recentGET(req(ORG), ctx(ORG))).status).toBe(401);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('down')))
    );
    expect((await recentGET(req(ORG), ctx(ORG))).status).toBe(502);
  });
});

// ── Componente ───────────────────────────────────────────────────────────────

function okResult(sessions: unknown[], intents: unknown[]): RecentChargesResult {
  return joinRecentCharges(sessions, intents);
}

describe('filterRecent / parseRecent', () => {
  it('filtra por fase y comercio dentro de la ventana', () => {
    const r = okResult(
      [session(1), session(2), session(3, 'expired'), session(4)],
      [
        intent(1, 'succeeded', M1),
        intent(2, 'failed', M2),
        intent(3, 'requires_payment_method', M1),
      ]
    );
    expect(
      filterRecent(r.ok ? r.rows : [], { phase: 'failed', merchantId: '' }).map((x) => x.session.id)
    ).toEqual([sid(2)]);
    expect(
      filterRecent(r.ok ? r.rows : [], { phase: '', merchantId: M1 }).map((x) => x.session.id)
    ).toEqual([sid(3), sid(1)]);
    // Sin intent en la ventana ⇒ fase «unknown» y no casa con ningún comercio.
    expect(
      filterRecent(r.ok ? r.rows : [], { phase: 'unknown', merchantId: '' }).map(
        (x) => x.session.id
      )
    ).toEqual([sid(4)]);
    expect(filterRecent(r.ok ? r.rows : [], { phase: 'expired', merchantId: M1 })).toHaveLength(1);
  });

  it('forma inesperada del BFF ⇒ null (error, no vacío)', () => {
    expect(parseRecent({ rows: [] })).toBeNull();
    expect(parseRecent({ rows: 'x', window: {} })).toBeNull();
    expect(
      parseRecent({ rows: [], window: { limit: 100, returned: 0, truncated: false } })
    ).not.toBeNull();
  });
});

describe('PosRecentCharges', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('muestra filas, ventana y enlaces a seguir/detalle (axe)', async () => {
    const onTrack = vi.fn();
    const { container } = render(
      <PosRecentCharges
        orgId={ORG}
        locale="es"
        merchants={MERCHANTS}
        initial={okResult([session(1, 'completed')], [intent(1, 'succeeded')])}
        onTrack={onTrack}
      />
    );
    expect(screen.getByText('Pago aprobado', { selector: '.badge' })).toBeInTheDocument();
    expect(screen.getByTestId('pos-recent-window')).toHaveTextContent('1 sesión');
    expect(screen.getByText('Demo Store', { selector: 'span' })).toBeInTheDocument();
    const track = screen.getByRole('link', { name: /^Seguir/ });
    expect(track).toHaveAttribute('href', `/o/${ORG}/pos?session=${sid(1)}`);
    expect(screen.getByRole('link', { name: /^Detalle/ })).toHaveAttribute(
      'href',
      `/o/${ORG}/payments/${pid(1)}`
    );
    fireEvent.click(track);
    expect(onTrack).toHaveBeenCalledWith(sid(1));
    const r = await axe.run(container);
    expect(r.violations).toEqual([]);
  });

  it('ventana truncada: lo dice y, al filtrar, remite a Pagos', async () => {
    const sessions = Array.from({ length: RECENT_WINDOW }, (_, i) => session(i));
    const intents = sessions.map((_, i) => intent(i, i === 5 ? 'failed' : 'succeeded'));
    render(
      <PosRecentCharges
        orgId={ORG}
        locale="es"
        merchants={MERCHANTS}
        initial={okResult(sessions, intents)}
      />
    );
    expect(screen.getByTestId('pos-recent-window')).toHaveTextContent(
      /las 100 sesiones más recientes.*Los filtros buscan solo aquí, no en todo el historial/
    );
    // Paginado local: 10 visibles + «Mostrar 10 más».
    expect(screen.getAllByRole('listitem')).toHaveLength(10);
    await userEvent.click(screen.getByRole('button', { name: 'Mostrar 10 más' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(20);

    await userEvent.selectOptions(screen.getByLabelText('Estado'), 'failed');
    expect(screen.getByTestId('pos-recent-count')).toHaveTextContent('1 de 100 en la ventana');
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Ir a Pagos' })).toHaveAttribute(
      'href',
      `/o/${ORG}/payments`
    );
  });

  it('filtro sin coincidencias ≠ historial vacío, y se puede limpiar', async () => {
    render(
      <PosRecentCharges
        orgId={ORG}
        locale="es"
        merchants={MERCHANTS}
        initial={okResult([session(1)], [intent(1, 'succeeded', M1)])}
      />
    );
    await userEvent.selectOptions(screen.getByLabelText('Comercio'), M2);
    expect(screen.getByText(/Ningún cobro de la ventana coincide/)).toBeInTheDocument();
    expect(screen.queryByText(/Aún no hay cobros/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Quitar filtros' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
  });

  it('vacío genuino, error y sesión caducada son estados distintos', () => {
    const props = { orgId: ORG, locale: 'es' as const, merchants: MERCHANTS };
    const { unmount } = render(<PosRecentCharges {...props} initial={okResult([], [])} />);
    expect(screen.getByText(/Aún no hay cobros/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    unmount();
    const u2 = render(
      <PosRecentCharges {...props} initial={{ ok: false, reason: 'unavailable' }} />
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Esto no significa que no haya cobros');
    expect(screen.queryByText(/Aún no hay cobros/)).toBeNull();
    u2.unmount();
    render(<PosRecentCharges {...props} initial={{ ok: false, reason: 'auth' }} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Tu sesión caducó');
    expect(screen.getByRole('link', { name: 'Iniciar sesión' })).toHaveAttribute('href', '/login');
  });

  it('error ⇒ Reintentar ⇒ carga y muestra los datos', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify(okResult([session(1)], [intent(1, 'failed')])), {
            status: 200,
          })
        )
      )
    );
    render(
      <PosRecentCharges
        orgId={ORG}
        locale="es"
        merchants={MERCHANTS}
        initial={{ ok: false, reason: 'unavailable' }}
      />
    );
    await userEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByText('Pago rechazado', { selector: '.badge' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(fetch).toHaveBeenCalledWith(`/api/orgs/${ORG}/pos/recent`, { cache: 'no-store' });
  });

  it('el aviso del terminal refresca la lista sin recargar (aprobado aparece)', async () => {
    let resolve!: (r: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((r) => (resolve = r)))
    );
    const initial = okResult([session(1)], [intent(1, 'requires_payment_method')]);
    const { rerender } = render(
      <PosRecentCharges
        orgId={ORG}
        locale="es"
        merchants={MERCHANTS}
        initial={initial}
        refreshSignal={0}
      />
    );
    expect(screen.getByText('Esperando al cliente', { selector: '.badge' })).toBeInTheDocument();
    rerender(
      <PosRecentCharges
        orgId={ORG}
        locale="es"
        merchants={MERCHANTS}
        initial={initial}
        refreshSignal={1}
      />
    );
    // Carga visible sin vaciar la lista.
    expect(await screen.findByRole('button', { name: 'Actualizando…' })).toBeDisabled();
    expect(screen.getByText('Esperando al cliente', { selector: '.badge' })).toBeInTheDocument();
    await act(async () => {
      resolve(
        new Response(
          JSON.stringify(okResult([session(1, 'completed')], [intent(1, 'succeeded')])),
          { status: 200 }
        )
      );
    });
    expect(await screen.findByText('Pago aprobado', { selector: '.badge' })).toBeInTheDocument();
  });

  it('401 al refrescar ⇒ sesión caducada, sin mostrar filas antiguas como actuales', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('{}', { status: 401 })))
    );
    render(
      <PosRecentCharges
        orgId={ORG}
        locale="es"
        merchants={MERCHANTS}
        initial={okResult([session(1)], [intent(1, 'succeeded')])}
      />
    );
    await userEvent.click(screen.getByRole('button', { name: 'Actualizar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Tu sesión caducó');
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  });

  it('cobro en seguimiento y venta sin cerrar bloquean «Seguir»', () => {
    render(
      <PosRecentCharges
        orgId={ORG}
        locale="es"
        merchants={MERCHANTS}
        initial={okResult([session(1), session(2)], [intent(1, 'succeeded'), intent(2, 'failed')])}
        activeSessionId={sid(2)}
        trackLocked
        onTrack={vi.fn()}
      />
    );
    const items = screen.getAllByRole('listitem');
    expect(items[0]).toHaveAttribute('aria-current', 'true');
    expect(within(items[0]!).getByText('En seguimiento')).toBeInTheDocument();
    const locked = within(items[1]!).getByRole('button', { name: 'Seguir' });
    expect(locked).toBeDisabled();
    expect(locked).toHaveAccessibleDescription(/Termina o descarta la venta en curso/);
  });

  it('inglés', () => {
    render(
      <PosRecentCharges
        orgId={ORG}
        locale="en"
        merchants={MERCHANTS}
        initial={okResult([session(1)], [intent(1, 'failed')])}
      />
    );
    expect(screen.getByText('Payment declined', { selector: '.badge' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Track/ })).toHaveAttribute(
      'href',
      `/o/${ORG}/pos?lang=en&session=${sid(1)}`
    );
  });
});
