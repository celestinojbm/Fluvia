import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { OnboardingWizard } from '../app/onboarding/onboarding-client';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../app/lib/csrf-header';

/**
 * F6.5C2 — wizard de onboarding (jsdom + axe, CI-gated): render accesible con
 * copy sandbox, dos pasos org→merchant, loading/anti doble-submit, errores
 * accesibles con foco, replay natural, recuperacion tras fallo del chart
 * (reintento gobernado por el estado real del backend) y redireccion final al
 * panel. El cliente jamas crea datos por si mismo ni ve secretos.
 */

afterEach(() => vi.unstubAllGlobals());

const ORG_OK = {
  organization: { id: 'org-1', name: 'Mi Empresa', slug: 'mi-empresa' },
  membership: { role: 'owner' },
  replayed: false,
};
const MERCHANT_OK = {
  merchant: { id: 'm-1', name: 'Mi Tienda', country: 'CO', defaultCurrency: 'COP' },
  chartReady: true,
  replayed: false,
};

type StubResponse = { status: number; body: unknown; delayMs?: number };

function stubFetchSequence(responses: StubResponse[]) {
  let call = 0;
  const fn = vi.fn((_url: string, _init?: RequestInit) => {
    const r = responses[Math.min(call, responses.length - 1)]!;
    call += 1;
    return new Promise<Response>((resolve) =>
      setTimeout(
        () => resolve(new Response(JSON.stringify(r.body), { status: r.status })),
        r.delayMs ?? 0
      )
    );
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

async function fillOrgStep() {
  await userEvent.type(screen.getByLabelText('Nombre de la organización'), 'Mi Empresa');
  await userEvent.type(screen.getByLabelText('Slug (identificador en URLs)'), 'mi-empresa');
  await userEvent.click(screen.getByRole('button', { name: 'Continuar' }));
}

async function fillMerchantStep() {
  await userEvent.type(screen.getByLabelText('Nombre del comercio'), 'Mi Tienda');
  await userEvent.click(screen.getByRole('button', { name: /Finalizar|Reintentar/ }));
}

describe('OnboardingWizard — paso 1 (organización)', () => {
  it('renders accessibly: SANDBOX copy, labelled fields, axe clean', async () => {
    const { container } = render(<OnboardingWizard locale="es" navigate={vi.fn()} />);
    expect(
      screen.getByRole('heading', { name: 'Onboarding — crea tu organización' })
    ).toBeInTheDocument();
    // Explica que es onboarding sandbox con dinero simulado.
    expect(screen.getByText(/onboarding del sandbox/)).toBeInTheDocument();
    expect(screen.getByText(/dinero simulado/)).toBeInTheDocument();
    expect(screen.getByText('Entorno de pruebas — no se mueve dinero real.')).toBeInTheDocument();
    expect(screen.getByText('Paso 1 de 2 — Organización')).toBeInTheDocument();
    expect(screen.getByLabelText('Nombre de la organización')).toBeInTheDocument();
    expect(screen.getByLabelText('Slug (identificador en URLs)')).toBeInTheDocument();
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });

  it('submits to the org proxy with the CSRF header and advances to step 2', async () => {
    const fetchFn = stubFetchSequence([{ status: 201, body: ORG_OK }]);
    render(<OnboardingWizard locale="es" navigate={vi.fn()} />);
    await fillOrgStep();

    expect(await screen.findByText('Paso 2 de 2 — Comercio')).toBeInTheDocument();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/onboarding/organization');
    expect((init.headers as Record<string, string>)[CSRF_HEADER]).toBe(CSRF_HEADER_VALUE);
    expect(JSON.parse(String(init.body))).toEqual({
      organizationName: 'Mi Empresa',
      slug: 'mi-empresa',
    });
  });

  it('anti double-submit: two clicks in flight => one request, loading visible', async () => {
    const fetchFn = stubFetchSequence([{ status: 201, body: ORG_OK, delayMs: 60 }]);
    render(<OnboardingWizard locale="es" navigate={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('Nombre de la organización'), 'Mi Empresa');
    await userEvent.type(screen.getByLabelText('Slug (identificador en URLs)'), 'mi-empresa');
    const button = screen.getByRole('button', { name: 'Continuar' });
    await userEvent.click(button);
    expect(screen.getByRole('button', { name: 'Creando organización…' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Creando organización…' }));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
  });

  it('slug taken: accessible error with focus; the form stays operable', async () => {
    stubFetchSequence([{ status: 409, body: { error: { code: 'organization_slug_taken' } } }]);
    render(<OnboardingWizard locale="es" navigate={vi.fn()} />);
    await fillOrgStep();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Ese slug ya está en uso. Elige otro.');
    await waitFor(() => expect(alert).toHaveFocus());
    expect(screen.getByRole('button', { name: 'Continuar' })).toBeEnabled();
  });

  it('onboarding already completed: stable error with a link to the dashboard (existing org is NOT recreated)', async () => {
    stubFetchSequence([{ status: 409, body: { error: { code: 'onboarding_already_completed' } } }]);
    render(<OnboardingWizard locale="es" navigate={vi.fn()} />);
    await fillOrgStep();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/onboarding ya está completado/);
    expect(screen.getByRole('link', { name: 'Ir al panel' })).toHaveAttribute('href', '/');
  });

  it('natural replay (200 replayed:true) recovers the org and shows the recovery notice on step 2', async () => {
    stubFetchSequence([{ status: 200, body: { ...ORG_OK, replayed: true } }]);
    render(<OnboardingWizard locale="es" navigate={vi.fn()} />);
    await fillOrgStep();
    expect(await screen.findByText('Paso 2 de 2 — Comercio')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Organización recuperada ✓ — continúa con tu comercio.'
    );
  });
});

describe('OnboardingWizard — paso 2 (comercio) y recorrido completo', () => {
  it('full journey org→merchant→dashboard: second POST to the merchant proxy, then redirect to the root', async () => {
    const fetchFn = stubFetchSequence([
      { status: 201, body: ORG_OK },
      { status: 201, body: MERCHANT_OK },
    ]);
    const navigate = vi.fn();
    render(<OnboardingWizard locale="es" navigate={navigate} />);
    await fillOrgStep();
    await screen.findByText('Paso 2 de 2 — Comercio');
    // axe tambien en el paso 2 (labels de comercio/pais/moneda).
    expect(screen.getByLabelText('Nombre del comercio')).toBeInTheDocument();
    expect(screen.getByLabelText('País (código ISO de 2 letras)')).toHaveValue('CO');
    expect(screen.getByLabelText('Moneda predeterminada')).toHaveValue('COP');
    await fillMerchantStep();

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/'));
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const [url, init] = fetchFn.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('/api/orgs/org-1/onboarding/merchant');
    expect((init.headers as Record<string, string>)[CSRF_HEADER]).toBe(CSRF_HEADER_VALUE);
    expect(JSON.parse(String(init.body))).toEqual({
      name: 'Mi Tienda',
      country: 'CO',
      defaultCurrency: 'COP',
    });
  });

  it('step 2 renders accessibly (axe clean)', async () => {
    stubFetchSequence([{ status: 201, body: ORG_OK }]);
    const { container } = render(<OnboardingWizard locale="es" navigate={vi.fn()} />);
    await fillOrgStep();
    await screen.findByText('Paso 2 de 2 — Comercio');
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });

  it('chart failure then retry: the retry recovers from real backend state and finishes (no client-side data creation)', async () => {
    const fetchFn = stubFetchSequence([
      { status: 201, body: ORG_OK },
      // Primer intento de merchant: fallo (p. ej. chart) => error estable.
      { status: 500, body: { error: { code: 'internal_error' } } },
      // Reintento: el backend recupera el merchant existente (replay) + chart.
      { status: 200, body: { ...MERCHANT_OK, replayed: true } },
    ]);
    const navigate = vi.fn();
    render(<OnboardingWizard locale="es" navigate={navigate} />);
    await fillOrgStep();
    await screen.findByText('Paso 2 de 2 — Comercio');
    await fillMerchantStep();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('No se pudo completar el paso. Reintenta.');
    await waitFor(() => expect(alert).toHaveFocus());
    expect(screen.getByText(/el estado real del backend gobierna la recuperación/)).toBeVisible();

    // Reintento: mismo formulario, el boton ahora dice Reintentar.
    await userEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/'));
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('merchant onboarding already completed: stable error with a link to the dashboard', async () => {
    stubFetchSequence([
      { status: 201, body: ORG_OK },
      { status: 409, body: { error: { code: 'merchant_onboarding_already_completed' } } },
    ]);
    render(<OnboardingWizard locale="es" navigate={vi.fn()} />);
    await fillOrgStep();
    await screen.findByText('Paso 2 de 2 — Comercio');
    await fillMerchantStep();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/ya fue creado con otros datos/);
    expect(screen.getByRole('link', { name: 'Ir al panel' })).toHaveAttribute('href', '/');
  });

  it('anti double-submit on step 2', async () => {
    const fetchFn = stubFetchSequence([
      { status: 201, body: ORG_OK },
      { status: 201, body: MERCHANT_OK, delayMs: 60 },
    ]);
    render(<OnboardingWizard locale="es" navigate={vi.fn()} />);
    await fillOrgStep();
    await screen.findByText('Paso 2 de 2 — Comercio');
    await userEvent.type(screen.getByLabelText('Nombre del comercio'), 'Mi Tienda');
    await userEvent.click(screen.getByRole('button', { name: 'Finalizar' }));
    expect(screen.getByRole('button', { name: 'Creando comercio…' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Creando comercio…' }));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2)); // org + merchant, no un tercero
  });

  it('renders in english too (locale propagates to the dashboard redirect)', async () => {
    stubFetchSequence([
      { status: 201, body: ORG_OK },
      { status: 201, body: MERCHANT_OK },
    ]);
    const navigate = vi.fn();
    render(<OnboardingWizard locale="en" navigate={navigate} />);
    expect(
      screen.getByRole('heading', { name: 'Onboarding — create your organization' })
    ).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Organization name'), 'My Company');
    await userEvent.type(screen.getByLabelText('Slug (URL identifier)'), 'my-company');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByText('Step 2 of 2 — Merchant');
    await userEvent.type(screen.getByLabelText('Merchant name'), 'My Store');
    await userEvent.click(screen.getByRole('button', { name: 'Finish' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/?lang=en'));
  });
});
