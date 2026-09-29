import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { CheckoutClient } from '../app/checkout-client';

/**
 * Tests de componente (jsdom, sin navegador) — corren en CI. El fetch a los
 * route handlers se mockea; verifican render, i18n, la interacción de pago y
 * la accesibilidad estructural (axe). El E2E real full-stack es Playwright
 * (`test:e2e`, local, porque el CI no tiene navegador).
 */

const OPEN_VIEW = {
  id: 's1',
  status: 'open',
  payment_intent: { id: 'pi1', status: 'created', amount: 50_000, currency: 'COP' },
};
const COMPLETED_VIEW = {
  id: 's1',
  status: 'completed',
  payment_intent: { id: 'pi1', status: 'succeeded', amount: 50_000, currency: 'COP' },
};

function mockFetch(handler: (url: string, init?: RequestInit) => unknown, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) =>
      Promise.resolve({
        ok: status < 400,
        status,
        json: () => Promise.resolve(handler(url, init)),
        text: () => Promise.resolve(JSON.stringify(handler(url, init))),
      })
    )
  );
}

beforeEach(() => {
  window.location.hash = '#cs_secret_123';
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CheckoutClient', () => {
  it('renders the amount and pending status (es), then pays and shows completed', async () => {
    mockFetch((url) => (url.includes('/confirm') ? COMPLETED_VIEW : OPEN_VIEW));
    render(<CheckoutClient sessionId="s1" locale="es" />);

    expect(await screen.findByTestId('amount')).toHaveTextContent('50.000');
    expect(screen.getByTestId('status')).toHaveTextContent('Pago pendiente');

    // El secreto viaja en el header hacia el route handler.
    expect(fetch).toHaveBeenCalledWith(
      '/api/checkout/s1/status',
      expect.objectContaining({
        headers: { 'x-checkout-client-secret': 'cs_secret_123' },
      })
    );

    await userEvent.click(screen.getByRole('button', { name: 'Pagar' }));
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('Pago completado'));
    expect(fetch).toHaveBeenCalledWith('/api/checkout/s1/confirm', expect.anything());
  });

  it('renders English strings for locale=en', async () => {
    mockFetch(() => OPEN_VIEW);
    render(<CheckoutClient sessionId="s1" locale="en" />);
    expect(await screen.findByRole('heading', { name: 'Complete payment' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Pay' })).toBeDefined();
    expect(screen.getByText('Amount due')).toBeDefined();
  });

  it('shows a not-found message for an invalid client_secret (404)', async () => {
    mockFetch(() => ({}), 404);
    render(<CheckoutClient sessionId="s1" locale="es" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('inválido');
  });

  it('lets the buyer pick the declined test method and reflects the failure', async () => {
    mockFetch((url) =>
      url.includes('/confirm')
        ? {
            id: 's1',
            status: 'open',
            payment_intent: { id: 'pi1', status: 'failed', amount: 50_000, currency: 'COP' },
          }
        : OPEN_VIEW
    );
    render(<CheckoutClient sessionId="s1" locale="es" />);
    await screen.findByTestId('amount');
    await userEvent.click(screen.getByRole('radio', { name: /rechazada/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Pagar' }));
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('rechazado'));
  });

  it('declined: does not promise another method in the same session (intent failed is terminal)', async () => {
    mockFetch((url) =>
      url.includes('/confirm')
        ? {
            id: 's1',
            status: 'open',
            payment_intent: { id: 'pi1', status: 'failed', amount: 50_000, currency: 'COP' },
          }
        : OPEN_VIEW
    );
    render(<CheckoutClient sessionId="s1" locale="es" />);
    await screen.findByTestId('amount');
    await userEvent.click(screen.getByRole('button', { name: 'Pagar' }));
    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('Pide al comercio un nuevo enlace')
    );
    expect(screen.queryByRole('button', { name: 'Pagar' })).toBeNull();
  });

  it('confirm with an unknown outcome (5xx) never invites paying again: check status first', async () => {
    let confirmed = false;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.includes('/confirm')) {
          confirmed = true;
          return Promise.resolve({ ok: false, status: 502, json: () => Promise.resolve({}) });
        }
        const view = confirmed ? COMPLETED_VIEW : OPEN_VIEW;
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(view) });
      })
    );
    render(<CheckoutClient sessionId="s1" locale="es" />);
    await screen.findByTestId('amount');
    await userEvent.click(screen.getByRole('button', { name: 'Pagar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No lo repitas');
    expect(screen.queryByRole('button', { name: 'Pagar' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Consultar estado' }));
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('Pago completado'));
  });

  it('a double submit sends a single confirm', async () => {
    let release: (v: unknown) => void = () => {};
    const confirmCalls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.includes('/confirm')) {
          confirmCalls.push(url);
          return new Promise((r) => {
            release = r;
          });
        }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(OPEN_VIEW) });
      })
    );
    render(<CheckoutClient sessionId="s1" locale="es" />);
    await screen.findByTestId('amount');
    const form = screen.getByRole('button', { name: 'Pagar' }).closest('form')!;
    form.requestSubmit();
    form.requestSubmit();
    expect(confirmCalls).toHaveLength(1);
    release({ ok: true, status: 200, json: () => Promise.resolve(COMPLETED_VIEW) });
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('Pago completado'));
  });

  it('load error offers a retry; a malformed id (400) reads as an invalid link', async () => {
    let fail = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        fail
          ? Promise.reject(new TypeError('network'))
          : Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(OPEN_VIEW) })
      )
    );
    const { unmount } = render(<CheckoutClient sessionId="s1" locale="es" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('No pudimos cargar');
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByTestId('amount')).toBeInTheDocument();
    unmount();

    mockFetch(() => ({}), 400);
    render(<CheckoutClient sessionId="bad" locale="es" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('inválido');
  });

  it('async method label is country-neutral', async () => {
    mockFetch(() => OPEN_VIEW);
    render(<CheckoutClient sessionId="s1" locale="es" />);
    await screen.findByTestId('amount');
    expect(screen.getByRole('radio', { name: /Transferencia de prueba/ })).toBeInTheDocument();
    expect(screen.queryByText(/PSE/)).toBeNull();
  });

  it('has no structural accessibility violations (axe)', async () => {
    mockFetch(() => OPEN_VIEW);
    const { container } = render(<CheckoutClient sessionId="s1" locale="es" />);
    await screen.findByTestId('amount');
    const results = await axe.run(container, {
      // El contraste requiere layout real (jsdom no lo tiene); se valida en el
      // E2E de navegador. Aquí se comprueban labels, roles, landmarks, headings.
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});
