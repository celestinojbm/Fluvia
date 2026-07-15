import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { WebhookEndpointDetailView, WebhookEndpointsList } from '../app/lib/webhook-endpoints-view';
import { SecretRevealOnce } from '../app/lib/secret-reveal-once';
import type { WebhookEndpoint } from '../app/lib/api';

/**
 * F6.5B1 — vistas de webhook endpoints (jsdom + axe, CI-gated). Lista/detalle
 * SOLO LECTURA (sin secreto); crear/rotar/desactivar solo con `webhooks:manage`.
 * El secreto `whsec_` vive solo en estado efímero y se revela una vez; los tests
 * fallan si un secreto se filtrara a list/detail o persistiera tras cerrar.
 */

const ACTIVE: WebhookEndpoint = {
  id: 'whep_abcdef123456',
  url: 'https://example.test/hook',
  events: ['payment_intent.succeeded'],
  status: 'active',
  description: 'prod hook',
  created_at: '2026-07-11T09:00:00Z',
  disabled_at: null,
};

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn(() =>
    Promise.resolve({
      ok: status < 400,
      status,
      clone: () => ({ json: () => Promise.resolve(body) }),
      json: () => Promise.resolve(body),
    })
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

/**
 * Secuencia de respuestas (RA-F65B-001): cada llamada a fetch consume la
 * siguiente entrada. Permite simular 403 mfa_step_up_required → step-up 200 →
 * reintento 200/201.
 */
function mockFetchSequence(responses: Array<{ status: number; body: unknown }>) {
  let i = 0;
  const fn = vi.fn((url: string, _init?: unknown) => {
    void url;
    const r = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    return Promise.resolve({
      ok: r.status < 400,
      status: r.status,
      clone: () => ({ json: () => Promise.resolve(r.body) }),
      json: () => Promise.resolve(r.body),
    });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const STEP_UP_REQUIRED = { status: 403, body: { error: { code: 'mfa_step_up_required' } } };

afterEach(() => {
  vi.unstubAllGlobals();
  delete (navigator as unknown as Record<string, unknown>).clipboard;
});

describe('WebhookEndpointsList', () => {
  it('lists endpoints linking to detail, and shows the empty state', () => {
    const { rerender } = render(
      <WebhookEndpointsList endpoints={[ACTIVE]} orgId="o1" locale="es" signOutHref="/logout" />
    );
    const link = screen.getByRole('link', { name: /whep_abc/ });
    expect(link.getAttribute('href')).toBe('/o/o1/webhook-endpoints/whep_abcdef123456');
    expect(screen.getByText('https://example.test/hook')).toBeInTheDocument();

    rerender(<WebhookEndpointsList endpoints={[]} orgId="o1" locale="es" signOutHref="/logout" />);
    expect(screen.getByText('Sin endpoints de webhook.')).toBeInTheDocument();
  });

  it('offers the create form only to roles with webhooks:manage', () => {
    const { rerender } = render(
      <WebhookEndpointsList endpoints={[ACTIVE]} orgId="o1" locale="es" signOutHref="/logout" />
    );
    expect(screen.getByText(/Tu rol no permite gestionar endpoints/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Crear endpoint' })).toBeNull();

    rerender(
      <WebhookEndpointsList
        endpoints={[ACTIVE]}
        orgId="o1"
        locale="es"
        signOutHref="/logout"
        canManage
      />
    );
    expect(screen.getByRole('button', { name: 'Crear endpoint' })).toBeInTheDocument();
  });

  it('creates an endpoint and reveals the whsec_ secret ONCE', async () => {
    const fn = mockFetch(201, {
      id: 'whep_new',
      object: 'webhook_endpoint',
      url: 'https://example.test/new',
      secret: 'whsec_REVEALEDONCE',
    });
    render(
      <WebhookEndpointsList endpoints={[]} orgId="o1" locale="es" signOutHref="/logout" canManage />
    );
    await userEvent.type(screen.getByLabelText('URL de destino'), 'https://example.test/new');
    await userEvent.click(screen.getByRole('button', { name: 'Crear endpoint' }));

    await waitFor(() => expect(screen.getByText('whsec_REVEALEDONCE')).toBeInTheDocument());
    expect(screen.getByText(/no se volverá a mostrar/)).toBeInTheDocument();
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/orgs/o1/webhook-endpoints');
    expect(JSON.parse(String(init.body))).toEqual({ url: 'https://example.test/new' });
    // RA-F65B-EXT-002: la mutación legítima porta el header anti-CSRF.
    expect((init.headers as Record<string, string>)['x-fluvia-csrf']).toBe('1');
  });

  it('SECURITY: a secret injected into a list endpoint never reaches the DOM', () => {
    const poisoned = {
      ...ACTIVE,
      secret: 'whsec_LEAKED',
      secret_enc: 'cipherblob',
      signing_secret: 'whsig_LEAK',
    } as unknown as WebhookEndpoint;
    const { container } = render(
      <WebhookEndpointsList endpoints={[poisoned]} orgId="o1" locale="es" signOutHref="/logout" />
    );
    const html = container.innerHTML;
    expect(html).not.toContain('whsec_LEAKED');
    expect(html).not.toContain('cipherblob');
    expect(html).not.toContain('whsig_LEAK');
    expect(html).toContain('https://example.test/hook');
  });
});

describe('WebhookEndpointDetailView', () => {
  it('renders fields, links to related webhook events, and shows actions only with canManage', () => {
    const { rerender } = render(
      <WebhookEndpointDetailView endpoint={ACTIVE} orgId="o1" locale="es" signOutHref="/logout" />
    );
    expect(screen.getByText('whep_abcdef123456')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ver eventos de webhook' }).getAttribute('href')).toBe(
      '/o/o1/webhook-events'
    );
    // Sin permiso: sin acciones mutantes.
    expect(screen.queryByRole('button', { name: 'Rotar secreto' })).toBeNull();

    rerender(
      <WebhookEndpointDetailView
        endpoint={ACTIVE}
        orgId="o1"
        locale="es"
        signOutHref="/logout"
        canManage
      />
    );
    expect(screen.getByRole('button', { name: 'Rotar secreto' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Desactivar' })).toBeInTheDocument();
  });

  it('SECURITY: a secret injected into the detail endpoint never reaches the DOM', () => {
    const poisoned = {
      ...ACTIVE,
      secret: 'whsec_DETAILLEAK',
      secret_enc: 'detailcipher',
    } as unknown as WebhookEndpoint;
    const { container } = render(
      <WebhookEndpointDetailView endpoint={poisoned} orgId="o1" locale="es" signOutHref="/logout" />
    );
    expect(container.innerHTML).not.toContain('whsec_DETAILLEAK');
    expect(container.innerHTML).not.toContain('detailcipher');
  });

  it('has no structural accessibility violations (axe)', async () => {
    const { container } = render(
      <WebhookEndpointDetailView
        endpoint={ACTIVE}
        orgId="o1"
        locale="es"
        signOutHref="/logout"
        canManage
      />
    );
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});

describe('SecretRevealOnce', () => {
  it('copies the secret only on explicit click and clears from the DOM on dismiss', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const onDismiss = vi.fn();
    const { container, unmount } = render(
      <SecretRevealOnce secret="whsec_ONCE" locale="es" onDismiss={onDismiss} />
    );
    // Visible, pero clipboard NO se tocó sin acción explícita.
    expect(screen.getByText('whsec_ONCE')).toBeInTheDocument();
    expect(writeText).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Copiar URL' }));
    expect(writeText).toHaveBeenCalledWith('whsec_ONCE');

    await userEvent.click(screen.getByRole('button', { name: 'Ya lo copié' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);

    // Tras desmontar (navegación), el secreto no permanece en el DOM.
    unmount();
    expect(container.innerHTML).toBe('');
  });

  it('SECURITY: the secret is never written to localStorage/sessionStorage', async () => {
    const setLocal = vi.spyOn(Storage.prototype, 'setItem');
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(() => Promise.resolve()) },
      configurable: true,
    });
    render(<SecretRevealOnce secret="whsec_NOSTORE" locale="es" onDismiss={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Copiar URL' }));
    // Nada tocó el storage con el secreto.
    for (const call of setLocal.mock.calls) {
      expect(String(call[1])).not.toContain('whsec_NOSTORE');
    }
    setLocal.mockRestore();
  });
});

// ── RA-F65B-001: step-up en las acciones de mutación del dashboard ────────────

describe('webhook endpoint mutations — step-up flow (RA-F65B-001)', () => {
  it('create opens the step-up modal on 403 and retries EXACTLY once after password', async () => {
    // 1) create → 403 step-up ; 2) /api/step-up/password → 200 ; 3) retry → 201.
    const fn = mockFetchSequence([
      STEP_UP_REQUIRED,
      { status: 200, body: { ok: true } },
      {
        status: 201,
        body: { id: 'whep_new', url: 'https://example.test/new', secret: 'whsec_AFTERSTEPUP' },
      },
    ]);
    render(
      <WebhookEndpointsList endpoints={[]} orgId="o1" locale="es" signOutHref="/logout" canManage />
    );
    await userEvent.type(screen.getByLabelText('URL de destino'), 'https://example.test/new');
    await userEvent.click(screen.getByRole('button', { name: 'Crear endpoint' }));

    // Aparece el modal de step-up.
    const modal = await screen.findByRole('dialog');
    expect(modal).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Contraseña'), 'my password');
    await userEvent.click(screen.getByRole('button', { name: 'Confirmar' }));

    // El secreto se revela tras el reintento único.
    await waitFor(() => expect(screen.getByText('whsec_AFTERSTEPUP')).toBeInTheDocument());

    // Exactamente 3 fetch: create + step-up + retry. Sin bucle.
    expect(fn).toHaveBeenCalledTimes(3);
    const urls = fn.mock.calls.map((c) => c[0]);
    expect(urls).toEqual([
      '/api/orgs/o1/webhook-endpoints',
      '/api/step-up/password',
      '/api/orgs/o1/webhook-endpoints',
    ]);
  });

  it('create with an MFA account: honest message, no bypass, no loop', async () => {
    // create → 403 ; step-up password → 403 mfa (cuenta con MFA) : NO reintenta.
    const fn = mockFetchSequence([STEP_UP_REQUIRED, STEP_UP_REQUIRED]);
    render(
      <WebhookEndpointsList endpoints={[]} orgId="o1" locale="es" signOutHref="/logout" canManage />
    );
    await userEvent.type(screen.getByLabelText('URL de destino'), 'https://example.test/mfa');
    await userEvent.click(screen.getByRole('button', { name: 'Crear endpoint' }));
    await screen.findByRole('dialog');
    await userEvent.type(screen.getByLabelText('Contraseña'), 'my password');
    await userEvent.click(screen.getByRole('button', { name: 'Confirmar' }));

    // Mensaje honesto de MFA dentro del modal; el secreto jamás se revela.
    await waitFor(() =>
      expect(screen.getByText(/MFA step-up aún no está disponible/)).toBeInTheDocument()
    );
    expect(screen.queryByText(/^whsec_/)).toBeNull();
    // create + step-up (fallido). Sin tercer intento: no hay bypass ni bucle.
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('rotate opens step-up and retries once, revealing the new secret', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fn = mockFetchSequence([
      STEP_UP_REQUIRED,
      { status: 200, body: { ok: true } },
      { status: 200, body: { id: 'whep_abcdef123456', secret: 'whsec_ROTATED', rotated: true } },
    ]);
    render(
      <WebhookEndpointDetailView
        endpoint={ACTIVE}
        orgId="o1"
        locale="es"
        signOutHref="/logout"
        canManage
      />
    );
    await userEvent.click(screen.getByRole('button', { name: 'Rotar secreto' }));
    await screen.findByRole('dialog');
    await userEvent.type(screen.getByLabelText('Contraseña'), 'my password');
    await userEvent.click(screen.getByRole('button', { name: 'Confirmar' }));

    await waitFor(() => expect(screen.getByText('whsec_ROTATED')).toBeInTheDocument());
    expect(fn).toHaveBeenCalledTimes(3);
    expect(fn.mock.calls.map((c) => c[0])).toEqual([
      '/api/orgs/o1/webhook-endpoints/whep_abcdef123456/rotate',
      '/api/step-up/password',
      '/api/orgs/o1/webhook-endpoints/whep_abcdef123456/rotate',
    ]);
    vi.restoreAllMocks();
  });

  it('cancelling the step-up modal aborts the action without a retry', async () => {
    const fn = mockFetchSequence([STEP_UP_REQUIRED]);
    render(
      <WebhookEndpointsList endpoints={[]} orgId="o1" locale="es" signOutHref="/logout" canManage />
    );
    await userEvent.type(screen.getByLabelText('URL de destino'), 'https://example.test/cancel');
    await userEvent.click(screen.getByRole('button', { name: 'Crear endpoint' }));
    await screen.findByRole('dialog');
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }));

    // Modal cerrado; solo el intento inicial ocurrió (sin step-up, sin retry).
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
