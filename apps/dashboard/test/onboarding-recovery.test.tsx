import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { OnboardingWizard } from '../app/onboarding/onboarding-client';
import { resolveMerchantState, selectOnboardingOrganization } from '../app/onboarding/resolve';
import { OrgList } from '../app/lib/org-list';
import type { Merchant, Org } from '../app/lib/api';

/**
 * F6.5C2 — recuperacion DURABLE del onboarding: el estado lo resuelve el
 * SERVIDOR (lecturas existentes con la cookie) y gobierna el paso inicial del
 * wizard. Un reload tras crear la org, o tras merchant-creado/chart-fallido,
 * retoma sin recrear filas ni depender del estado del componente; `?orgId=`
 * solo selecciona organizaciones OWNER del propio usuario (fail-safe); 2+
 * merchants => onboarding no aplicable sin seleccion arbitraria; y el
 * dashboard conserva una via visible («Configurar / continuar onboarding
 * sandbox») ademas del enlace normal.
 */

afterEach(() => vi.unstubAllGlobals());

const org = (id: string, role: string, name = `Org ${id}`): Org => ({
  organization_id: id,
  name,
  slug: `slug-${id}`,
  role,
});

const merchant = (name: string): Merchant => ({
  id: `m-${name}`,
  name,
  country: 'CO',
  defaultCurrency: 'COP',
  status: 'active',
  createdAt: '2026-07-17T00:00:00.000Z',
});

const INITIAL_ORG = { id: 'org-1', name: 'Mi Empresa', slug: 'mi-empresa' };
const INITIAL_MERCHANT = { name: 'Mi Tienda', country: 'CO', defaultCurrency: 'COP' };

function stubFetch(status: number, body: unknown) {
  const fn = vi.fn((_url: string, _init?: RequestInit) =>
    Promise.resolve(new Response(JSON.stringify(body), { status }))
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('selectOnboardingOrganization (validacion server-side de orgId)', () => {
  it('user without organizations => null (Paso 1)', () => {
    expect(selectOnboardingOrganization([])).toBeNull();
    expect(selectOnboardingOrganization([], 'org-x')).toBeNull();
  });

  it('defaults to the first OWNER organization; non-owner memberships never qualify', () => {
    const orgs = [org('a', 'developer'), org('b', 'owner'), org('c', 'owner')];
    expect(selectOnboardingOrganization(orgs)).toEqual({
      id: 'b',
      name: 'Org b',
      slug: 'slug-b',
    });
    // Solo membresias no-owner => Paso 1 (no hay onboarding que retomar).
    expect(selectOnboardingOrganization([org('a', 'developer')])).toBeNull();
  });

  it('a valid ?orgId picks that OWNER organization', () => {
    const orgs = [org('a', 'owner'), org('b', 'owner')];
    expect(selectOnboardingOrganization(orgs, 'b')?.id).toBe('b');
  });

  it('a foreign/unknown/non-owner orgId is IGNORED (fail-safe, no leak): falls back to own default', () => {
    const orgs = [org('a', 'owner'), org('b', 'developer')];
    // Inexistente, ajena (no esta en la lista de la sesion) y no-owner: en
    // todos los casos NO se usa el orgId del query string.
    expect(selectOnboardingOrganization(orgs, 'zzz')?.id).toBe('a');
    expect(selectOnboardingOrganization(orgs, 'b')?.id).toBe('a');
    // Sin org owner propia + orgId ajeno => null, jamas datos del ajeno.
    expect(selectOnboardingOrganization([org('b', 'developer')], 'zzz')).toBeNull();
  });
});

describe('resolveMerchantState (0 / 1 / 2+ merchants)', () => {
  it('0 => Paso 2 vacio; 1 => prellenado; 2+ => onboarding no aplicable (sin seleccion)', () => {
    expect(resolveMerchantState([])).toEqual({ initialMerchant: null, notApplicable: false });
    expect(resolveMerchantState([merchant('Solo Uno')])).toEqual({
      initialMerchant: { name: 'Solo Uno', country: 'CO', defaultCurrency: 'COP' },
      notApplicable: false,
    });
    expect(resolveMerchantState([merchant('Uno'), merchant('Dos')])).toEqual({
      initialMerchant: null,
      notApplicable: true,
    });
  });
});

describe('OnboardingWizard — estados recuperados desde el servidor', () => {
  it('org owner + cero merchants => arranca en Paso 2 (sin exigir recordar name/slug), axe limpio', async () => {
    const { container } = render(
      <OnboardingWizard locale="es" navigate={vi.fn()} initialOrganization={INITIAL_ORG} />
    );
    expect(screen.getByText('Paso 2 de 2 — Comercio')).toBeInTheDocument();
    expect(screen.queryByText('Paso 1 de 2 — Organización')).not.toBeInTheDocument();
    // Comunica que el estado vino del servidor, con la organizacion real.
    expect(screen.getByRole('status')).toHaveTextContent(
      'Estado recuperado del servidor: tu organización ya existe (Mi Empresa)'
    );
    expect(screen.getByLabelText('Nombre del comercio')).toHaveValue('');
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });

  it('org + UN merchant => Paso 2 PRELLENADO con aviso de recuperacion, axe limpio', async () => {
    const { container } = render(
      <OnboardingWizard
        locale="es"
        navigate={vi.fn()}
        initialOrganization={INITIAL_ORG}
        initialMerchant={INITIAL_MERCHANT}
      />
    );
    expect(screen.getByLabelText('Nombre del comercio')).toHaveValue('Mi Tienda');
    expect(screen.getByLabelText('País (código ISO de 2 letras)')).toHaveValue('CO');
    expect(screen.getByLabelText('Moneda predeterminada')).toHaveValue('COP');
    expect(screen.getByText(/los datos se prellenaron desde el servidor/)).toBeInTheDocument();
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });

  it('submit del merchant recuperado => POST idempotente, backend responde replay + chart, redirige', async () => {
    const fetchFn = stubFetch(200, {
      merchant: { id: 'm-1', ...INITIAL_MERCHANT },
      chartReady: true,
      replayed: true,
    });
    const navigate = vi.fn();
    render(
      <OnboardingWizard
        locale="es"
        navigate={navigate}
        initialOrganization={INITIAL_ORG}
        initialMerchant={INITIAL_MERCHANT}
      />
    );
    await userEvent.click(screen.getByRole('button', { name: 'Finalizar' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/'));
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/orgs/org-1/onboarding/merchant');
    // Payload = datos reales del servidor, no memoria del operador.
    expect(JSON.parse(String(init.body))).toEqual({
      name: 'Mi Tienda',
      country: 'CO',
      defaultCurrency: 'COP',
    });
  });

  it('reload tras fallo de chart: montado con estado recuperado, un fallo mas se puede REINTENTAR', async () => {
    let call = 0;
    const responses = [
      { status: 500, body: { ok: false, error: { code: 'internal_error' } } },
      {
        status: 200,
        body: { merchant: { id: 'm-1', ...INITIAL_MERCHANT }, chartReady: true, replayed: true },
      },
    ];
    const fetchFn = vi.fn(() => {
      const r = responses[Math.min(call, responses.length - 1)]!;
      call += 1;
      return Promise.resolve(new Response(JSON.stringify(r.body), { status: r.status }));
    });
    vi.stubGlobal('fetch', fetchFn);
    const navigate = vi.fn();
    render(
      <OnboardingWizard
        locale="es"
        navigate={navigate}
        initialOrganization={INITIAL_ORG}
        initialMerchant={INITIAL_MERCHANT}
      />
    );
    await userEvent.click(screen.getByRole('button', { name: 'Finalizar' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('No se pudo completar el paso. Reintenta.');
    // Reintento: el backend idempotente recupera merchant + completa el chart.
    await userEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/'));
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('2+ merchants => onboarding no aplicable: sin formulario, sin seleccion arbitraria, enlace al panel, axe limpio', async () => {
    const { container } = render(
      <OnboardingWizard
        locale="es"
        navigate={vi.fn()}
        initialOrganization={INITIAL_ORG}
        onboardingNotApplicable
      />
    );
    expect(screen.getByText(/el onboarding inicial ya no aplica/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Nombre del comercio')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ir al panel' })).toHaveAttribute('href', '/');
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });

  it('sin props: el flujo nuevo arranca en Paso 1 (sin regresion del recorrido normal)', () => {
    render(<OnboardingWizard locale="es" navigate={vi.fn()} />);
    expect(screen.getByText('Paso 1 de 2 — Organización')).toBeInTheDocument();
  });
});

describe('OrgList — via visible para continuar el onboarding desde el dashboard', () => {
  it('owner: conserva el enlace normal Y añade la accion secundaria hacia /onboarding?orgId=…', () => {
    render(<OrgList locale="es" orgs={[org('org-1', 'owner', 'Mi Empresa')]} />);
    // El enlace normal al panel de la organizacion NO se sustituye.
    expect(screen.getByRole('link', { name: /Mi Empresa owner/ })).toHaveAttribute(
      'href',
      '/o/org-1'
    );
    expect(
      screen.getByRole('link', { name: /Configurar \/ continuar onboarding sandbox — Mi Empresa/ })
    ).toHaveAttribute('href', '/onboarding?orgId=org-1');
  });

  it('la accion secundaria conserva el locale (lang=en)', () => {
    render(<OrgList locale="en" orgs={[org('org-1', 'owner', 'My Company')]} />);
    expect(
      screen.getByRole('link', { name: /Set up \/ continue sandbox onboarding — My Company/ })
    ).toHaveAttribute('href', '/onboarding?orgId=org-1&lang=en');
  });

  it('roles no-owner conservan SOLO su enlace normal (sin accion de onboarding)', async () => {
    const { container } = render(
      <OrgList locale="es" orgs={[org('org-2', 'developer', 'Ajena SA')]} />
    );
    expect(screen.getByRole('link', { name: /Ajena SA developer/ })).toHaveAttribute(
      'href',
      '/o/org-2'
    );
    expect(screen.queryByText(/continuar onboarding/)).not.toBeInTheDocument();
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});
