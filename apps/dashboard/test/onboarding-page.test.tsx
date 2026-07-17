import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import OnboardingPage from '../app/onboarding/page';

/**
 * RA-F65C2-EXT-002/003 — flujo SERVER de `/onboarding` (el page async con
 * cookies + fetch reales mockeados): fallos de lectura JAMAS se muestran como
 * estado vacio ni habilitan formularios/mutaciones; 401 redirige a login;
 * seleccion invalida no lee merchants; 2+ owners exigen selector explicito.
 */

vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) =>
        name === 'fluvia_session' ? { value: 'session-token-test' } : undefined,
    }),
}));

class RedirectSentinel extends Error {
  constructor(readonly url: string) {
    super(`redirect:${url}`);
  }
}
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new RedirectSentinel(url);
  },
}));

afterEach(() => vi.unstubAllGlobals());

const ORG = (id: string, role = 'owner', name = `Org ${id}`) => ({
  organization_id: id,
  name,
  slug: `slug-${id}`,
  role,
});
const MERCHANT = { id: 'm-1', name: 'Mi Tienda', country: 'CO', defaultCurrency: 'COP' };

/** Stub por-URL: organizations y merchants con respuestas independientes. */
function stubBackend(spec: {
  organizations?: { status: number; body?: unknown; raw?: string; reject?: boolean };
  merchants?: { status: number; body?: unknown; raw?: string; reject?: boolean };
}) {
  const fn = vi.fn((url: string) => {
    const r = String(url).includes('/merchants') ? spec.merchants : spec.organizations;
    if (!r) throw new Error(`unexpected fetch: ${url}`);
    if (r.reject) return Promise.reject(new Error('ECONNREFUSED'));
    return Promise.resolve(
      new Response(
        r.raw !== undefined ? r.raw : r.body === undefined ? null : JSON.stringify(r.body),
        { status: r.status }
      )
    );
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

async function renderPage(params: { lang?: string; orgId?: string } = {}) {
  return render(await OnboardingPage({ searchParams: Promise.resolve(params) }));
}

function expectNoMutationSurface() {
  // Ningun wizard/formulario de creacion; ningun input de merchant.
  expect(screen.queryByLabelText('Nombre de la organización')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Nombre del comercio')).not.toBeInTheDocument();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
}

describe('flujo server de /onboarding — lecturas fail-closed', () => {
  it('organizations HTTP 500 => estado de lectura fallida (ni Paso 1 ni formulario), cero POST, retry visible', async () => {
    const fetchFn = stubBackend({ organizations: { status: 500, body: {} } });
    await renderPage();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'No pudimos leer el estado del onboarding.'
    );
    expectNoMutationSurface();
    expect(screen.getByRole('link', { name: 'Reintentar' })).toHaveAttribute('href', '/onboarding');
    // Solo el GET de organizations; jamas merchants ni un POST de mutacion.
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(String(fetchFn.mock.calls[0]![0])).toContain('/v1/organizations');
  });

  it('organizations 401 => redirige a /login (patron existente)', async () => {
    stubBackend({ organizations: { status: 401, body: {} } });
    await expect(renderPage()).rejects.toThrow('redirect:/login');
  });

  it('organizations con red caida / JSON invalido / shape invalido => lectura fallida, no vacio', async () => {
    for (const spec of [
      { organizations: { status: 200, reject: true } },
      { organizations: { status: 200, raw: 'not-json{' } },
      { organizations: { status: 200, body: { organizations: [{ organization_id: 42 }] } } },
    ]) {
      stubBackend(spec);
      const { unmount } = await renderPage();
      expect(screen.getByRole('alert')).toHaveTextContent('No pudimos leer');
      expectNoMutationSurface();
      unmount();
    }
  });

  it('merchants HTTP 500 => lectura fallida CONSERVANDO la seleccion valida en el retry; sin formulario', async () => {
    const fetchFn = stubBackend({
      organizations: { status: 200, body: { organizations: [ORG('a')] } },
      merchants: { status: 500, body: {} },
    });
    await renderPage();
    expect(screen.getByRole('alert')).toHaveTextContent('No pudimos leer');
    expectNoMutationSurface();
    expect(screen.getByRole('link', { name: 'Reintentar' })).toHaveAttribute(
      'href',
      '/onboarding?orgId=a'
    );
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('merchants 401 => redirige a /login; merchants 404/red/shape => lectura fallida', async () => {
    stubBackend({
      organizations: { status: 200, body: { organizations: [ORG('a')] } },
      merchants: { status: 401, body: {} },
    });
    await expect(renderPage()).rejects.toThrow('redirect:/login');

    for (const merchants of [
      { status: 404, body: {} },
      { status: 200, reject: true },
      { status: 200, body: { merchants: [{ id: '' }] } },
    ]) {
      stubBackend({
        organizations: { status: 200, body: { organizations: [ORG('a')] } },
        merchants,
      });
      const { unmount } = await renderPage();
      expect(screen.getByRole('alert')).toHaveTextContent('No pudimos leer');
      expectNoMutationSurface();
      unmount();
    }
  });
});

describe('flujo server de /onboarding — seleccion explicita', () => {
  it('sin organizaciones => Paso 1 (flujo nuevo intacto)', async () => {
    stubBackend({ organizations: { status: 200, body: { organizations: [] } } });
    await renderPage();
    expect(screen.getByText('Paso 1 de 2 — Organización')).toBeInTheDocument();
  });

  it('una owner + cero merchants => Paso 2 vacio; una owner + un merchant => Paso 2 PRELLENADO', async () => {
    stubBackend({
      organizations: { status: 200, body: { organizations: [ORG('a', 'owner', 'Mi Empresa')] } },
      merchants: { status: 200, body: { merchants: [] } },
    });
    const first = await renderPage();
    expect(screen.getByText('Paso 2 de 2 — Comercio')).toBeInTheDocument();
    expect(screen.getByLabelText('Nombre del comercio')).toHaveValue('');
    first.unmount();

    stubBackend({
      organizations: { status: 200, body: { organizations: [ORG('a', 'owner', 'Mi Empresa')] } },
      merchants: { status: 200, body: { merchants: [MERCHANT] } },
    });
    await renderPage();
    expect(screen.getByLabelText('Nombre del comercio')).toHaveValue('Mi Tienda');
    expect(screen.getByText(/los datos se prellenaron desde el servidor/)).toBeInTheDocument();
  });

  it('dos owners sin orgId => SELECTOR explicito (sin formulario) y NINGUNA lectura de merchants', async () => {
    const fetchFn = stubBackend({
      organizations: {
        status: 200,
        body: { organizations: [ORG('a', 'owner', 'Empresa A'), ORG('b', 'owner', 'Empresa B')] },
      },
    });
    await renderPage();
    expect(screen.getByText(/Elige explícitamente/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Empresa A/ })).toHaveAttribute(
      'href',
      '/onboarding?orgId=a'
    );
    expectNoMutationSurface();
    expect(fetchFn).toHaveBeenCalledTimes(1); // merchants JAMAS se leyo
  });

  it('orgId=b con owner de A y B => continua con B (seleccion explicita valida)', async () => {
    stubBackend({
      organizations: {
        status: 200,
        body: { organizations: [ORG('a', 'owner'), ORG('b', 'owner', 'Empresa B')] },
      },
      merchants: { status: 200, body: { merchants: [] } },
    });
    await renderPage({ orgId: 'b' });
    expect(screen.getByRole('status')).toHaveTextContent('Empresa B');
  });

  it('orgId inexistente/ajeno/no-owner => estado invalido GENERICO, sin fallback y SIN lectura de merchants', async () => {
    for (const requested of ['ghost', 'c']) {
      const fetchFn = stubBackend({
        organizations: {
          status: 200,
          body: { organizations: [ORG('a', 'owner', 'Mia SA'), ORG('c', 'developer')] },
        },
      });
      const { unmount } = await renderPage({ orgId: requested });
      expect(screen.getByRole('alert')).toHaveTextContent('no está disponible');
      // Sin fallback: no se muestra el Paso 2 de la owner propia; solo el
      // panel con sus opciones owner como enlaces.
      expectNoMutationSurface();
      expect(screen.getByRole('link', { name: /Mia SA/ })).toHaveAttribute(
        'href',
        '/onboarding?orgId=a'
      );
      expect(fetchFn).toHaveBeenCalledTimes(1); // cero merchant reads
      unmount();
    }
  });

  it('cero owners + orgId invalido => estado invalido con enlace a onboarding NUEVO (no Paso 1 silencioso)', async () => {
    stubBackend({ organizations: { status: 200, body: { organizations: [] } } });
    await renderPage({ orgId: 'ghost' });
    expect(screen.getByRole('alert')).toHaveTextContent('no está disponible');
    expect(screen.queryByText('Paso 1 de 2 — Organización')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Iniciar un onboarding nuevo' })).toHaveAttribute(
      'href',
      '/onboarding'
    );
  });
});
