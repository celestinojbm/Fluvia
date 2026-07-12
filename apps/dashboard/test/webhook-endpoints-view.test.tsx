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
