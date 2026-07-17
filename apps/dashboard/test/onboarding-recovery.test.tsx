import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { OnboardingWizard } from '../app/onboarding/onboarding-client';
import { resolveMerchantState, resolveOnboardingOrganization } from '../app/onboarding/resolve';
import {
  InvalidSelectionPanel,
  OrgSelectionPanel,
  ReadErrorPanel,
} from '../app/onboarding/onboarding-panels';
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

describe('resolveOnboardingOrganization (RA-F65C2-EXT-002: seleccion EXPLICITA, sin fallback)', () => {
  it('sin orgId + cero organizaciones owner => new_onboarding (Paso 1); no-owner jamas califica', () => {
    expect(resolveOnboardingOrganization([])).toEqual({ kind: 'new_onboarding' });
    expect(resolveOnboardingOrganization([org('a', 'developer')])).toEqual({
      kind: 'new_onboarding',
    });
  });

  it('sin orgId + exactamente una owner => selected', () => {
    const res = resolveOnboardingOrganization([org('x', 'developer'), org('a', 'owner')]);
    expect(res).toEqual({
      kind: 'selected',
      organization: { id: 'a', name: 'Org a', slug: 'slug-a' },
    });
  });

  it('sin orgId + dos o mas owners => selection_required (JAMAS owned[0]); ofrece solo las propias', () => {
    const res = resolveOnboardingOrganization([org('a', 'owner'), org('b', 'owner')]);
    expect(res.kind).toBe('selection_required');
    expect(
      (res as { kind: 'selection_required'; options: Array<{ id: string }> }).options.map(
        (o) => o.id
      )
    ).toEqual(['a', 'b']);
  });

  it('owner de A y B: orgId=A => A; orgId=B => B', () => {
    const orgs = [org('a', 'owner'), org('b', 'owner')];
    expect(resolveOnboardingOrganization(orgs, 'a')).toMatchObject({
      kind: 'selected',
      organization: { id: 'a' },
    });
    expect(resolveOnboardingOrganization(orgs, 'b')).toMatchObject({
      kind: 'selected',
      organization: { id: 'b' },
    });
  });

  it('orgId inexistente/ajeno/no-owner => invalid_selection SIN fallback (indistinguibles entre si)', () => {
    const orgs = [org('a', 'owner'), org('b', 'developer')];
    // Inexistente, ajeno (no esta en la lista de la sesion) y membership
    // no-owner producen el MISMO resultado: sin fallback a owned[0], solo las
    // organizaciones owner propias como opciones.
    for (const requested of ['zzz', 'b']) {
      const res = resolveOnboardingOrganization(orgs, requested);
      expect(res.kind).toBe('invalid_selection');
      expect(
        (res as { kind: 'invalid_selection'; options: Array<{ id: string }> }).options.map(
          (o) => o.id
        )
      ).toEqual(['a']);
    }
  });

  it('cero owners + orgId invalido => invalid_selection con cero opciones (no Paso 1 silencioso)', () => {
    expect(resolveOnboardingOrganization([org('b', 'developer')], 'zzz')).toEqual({
      kind: 'invalid_selection',
      options: [],
    });
    expect(resolveOnboardingOrganization([], 'zzz')).toEqual({
      kind: 'invalid_selection',
      options: [],
    });
  });
});

describe('paneles de seleccion / seleccion invalida / lectura fallida (server-rendered)', () => {
  const OPTIONS = [
    { id: 'a', name: 'Empresa A', slug: 'empresa-a' },
    { id: 'b', name: 'Empresa B', slug: 'empresa-b' },
  ];

  it('selection_required: opciones como ENLACES explicitos a /onboarding?orgId=…, sin formulario, axe limpio', async () => {
    const { container } = render(<OrgSelectionPanel options={OPTIONS} locale="es" />);
    expect(screen.getByText(/Elige explícitamente/)).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Continuar onboarding con esta organización — Empresa A/ })
    ).toHaveAttribute('href', '/onboarding?orgId=a');
    expect(
      screen.getByRole('link', { name: /Continuar onboarding con esta organización — Empresa B/ })
    ).toHaveAttribute('href', '/onboarding?orgId=b');
    // Ningun formulario ni select con mutacion automatica.
    expect(container.querySelector('form')).toBeNull();
    expect(container.querySelector('select')).toBeNull();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });

  it('selection_required: los enlaces conservan el locale (lang=en)', () => {
    render(<OrgSelectionPanel options={[OPTIONS[0]!]} locale="en" />);
    expect(
      screen.getByRole('link', { name: /Continue onboarding with this organization — Empresa A/ })
    ).toHaveAttribute('href', '/onboarding?orgId=a&lang=en');
  });

  it('invalid_selection: mensaje GENERICO (no revela existencia), solo opciones owner propias, axe limpio', async () => {
    const { container } = render(<InvalidSelectionPanel options={[OPTIONS[0]!]} locale="es" />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Esa organización no está disponible');
    // Sin formulario de mutacion; sin IDs ajenos (solo la owner propia).
    expect(container.querySelector('form')).toBeNull();
    expect(screen.getByRole('link', { name: /Empresa A/ })).toHaveAttribute(
      'href',
      '/onboarding?orgId=a'
    );
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });

  it('invalid_selection sin owners: enlace explicito a un onboarding NUEVO (sin orgId), no Paso 1 silencioso', () => {
    render(<InvalidSelectionPanel options={[]} locale="es" />);
    expect(screen.getByRole('alert')).toHaveTextContent('no está disponible');
    expect(screen.getByRole('link', { name: 'Iniciar un onboarding nuevo' })).toHaveAttribute(
      'href',
      '/onboarding'
    );
    expect(screen.queryByLabelText('Nombre de la organización')).not.toBeInTheDocument();
  });

  it('lectura fallida: estado recuperable con retry que conserva seleccion y locale; sin detalles internos', async () => {
    const { container } = render(<ReadErrorPanel locale="en" retryOrgId="a" />);
    expect(screen.getByRole('alert')).toHaveTextContent('We could not read the onboarding state.');
    expect(screen.getByRole('link', { name: 'Retry' })).toHaveAttribute(
      'href',
      '/onboarding?orgId=a&lang=en'
    );
    // Cero detalles de red/stack/body/backend.
    expect(container.textContent).not.toMatch(/500|stack|fetch|ECONN|http/i);
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
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
