import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { resolveLinkSession } from '../app/l/[id]/resolve';
import { LinkUnavailable } from '../app/l/[id]/link-unavailable';

/**
 * F3-06-b — abrir un payment link. La página `/l/[id]` es un server component que
 * hace el `POST :id/sessions` y `redirect()`; aquí se prueba (sin navegador, en
 * CI) la lógica pura de resolución y la vista de indisponibilidad. El E2E real de
 * navegador (Chromium → API → PG → redirección con fragmento) es local
 * (`apps/checkout/e2e/README.md`), porque el CI no tiene navegador.
 */

function fakeFetch(status: number, body: unknown): typeof fetch {
  return vi.fn(() =>
    Promise.resolve({ status, json: () => Promise.resolve(body) })
  ) as unknown as typeof fetch;
}

describe('resolveLinkSession', () => {
  it('redirects to the hosted flow with the secret in the fragment', async () => {
    const target = await resolveLinkSession({
      apiBase: 'http://api',
      linkId: 'lnk1',
      fetchImpl: fakeFetch(200, {
        checkout_session_id: 'cs_sess_1',
        client_secret: 'cs_secret_abc',
      }),
    });
    expect(target).toBe('/c/cs_sess_1#cs_secret_abc');
  });

  it('preserves an explicit English locale through the redirect', async () => {
    const target = await resolveLinkSession({
      apiBase: 'http://api',
      linkId: 'lnk1',
      lang: 'en',
      fetchImpl: fakeFetch(200, { checkout_session_id: 's2', client_secret: 'cs_x' }),
    });
    expect(target).toBe('/c/s2?lang=en#cs_x');
  });

  it('posts to the public sessions endpoint of the given link', async () => {
    const spy = fakeFetch(200, { checkout_session_id: 's', client_secret: 'cs_y' });
    await resolveLinkSession({ apiBase: 'http://api', linkId: 'l 3', fetchImpl: spy });
    expect(spy).toHaveBeenCalledWith(
      'http://api/v1/payment_links/l%203/sessions',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('returns null for a 404 (disabled/missing link) — same as anti-enumeration', async () => {
    expect(
      await resolveLinkSession({
        apiBase: 'http://api',
        linkId: 'x',
        fetchImpl: fakeFetch(404, {}),
      })
    ).toBeNull();
  });

  it('returns null when the API is unreachable or the body is malformed', async () => {
    const boom = vi.fn(() => Promise.reject(new Error('down'))) as unknown as typeof fetch;
    expect(
      await resolveLinkSession({ apiBase: 'http://api', linkId: 'x', fetchImpl: boom })
    ).toBeNull();

    const partial = await resolveLinkSession({
      apiBase: 'http://api',
      linkId: 'x',
      fetchImpl: fakeFetch(200, { checkout_session_id: 's' }), // sin client_secret
    });
    expect(partial).toBeNull();
  });
});

describe('LinkUnavailable', () => {
  it('shows the localized anti-enumeration message with no a11y violations', async () => {
    const { container } = render(<LinkUnavailable locale="es" />);
    expect(screen.getByRole('alert')).toHaveTextContent('inválido');
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});
