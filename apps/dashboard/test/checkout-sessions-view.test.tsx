import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import {
  CheckoutSessionDetail,
  CheckoutSessionsList,
} from '../app/lib/checkout-sessions-view';
import type { CheckoutSession } from '../app/lib/api';

/**
 * F6.5A — vistas de sesiones de checkout (jsdom + axe, CI-gated). La única
 * interacción es COPIAR la URL sandbox (no mutante: jamás toca el API).
 */

const SESSION: CheckoutSession = {
  id: 'cs_abcdef123456',
  payment_intent_id: 'pi_abcdef123456',
  customer_id: null,
  status: 'open',
  url: 'http://localhost:3100/c/cs_abcdef123456',
  success_url: null,
  cancel_url: null,
  expires_at: '2026-07-05T11:00:00Z',
  completed_at: null,
  created_at: '2026-07-05T10:05:00Z',
};

function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
}

afterEach(() => {
  // El clipboard stubeado no debe filtrarse a otros tests.
  delete (navigator as unknown as Record<string, unknown>).clipboard;
});

describe('CheckoutSessionsList', () => {
  it('lists sessions linking to detail and to the parent payment, and shows the empty state', () => {
    const { rerender } = render(
      <CheckoutSessionsList sessions={[SESSION]} orgId="o1" locale="es" signOutHref="/logout" />
    );
    const sessionLink = screen.getByRole('link', { name: /cs_abcd/ });
    expect(sessionLink.getAttribute('href')).toBe('/o/o1/checkout-sessions/cs_abcdef123456');
    const paymentLink = screen.getByRole('link', { name: /pi_abcd/ });
    expect(paymentLink.getAttribute('href')).toBe('/o/o1/payments/pi_abcdef123456');
    expect(screen.getByText('open')).toBeInTheDocument();

    rerender(
      <CheckoutSessionsList sessions={[]} orgId="o1" locale="es" signOutHref="/logout" />
    );
    expect(screen.getByText('Sin sesiones de checkout.')).toBeInTheDocument();
  });
});

describe('CheckoutSessionDetail', () => {
  it('renders the session fields, the sandbox URL, and copies it to the clipboard', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    stubClipboard(writeText);
    render(
      <CheckoutSessionDetail session={SESSION} orgId="o1" locale="es" signOutHref="/logout" />
    );
    expect(screen.getByText('cs_abcdef123456')).toBeInTheDocument();
    expect(screen.getByText('http://localhost:3100/c/cs_abcdef123456')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Copiar URL' }));
    expect(writeText).toHaveBeenCalledWith('http://localhost:3100/c/cs_abcdef123456');
    expect(await screen.findByText('Copiada ✓')).toBeInTheDocument();
  });

  it('degrades to a visible error when the clipboard is unavailable or denied', async () => {
    stubClipboard(() => Promise.reject(new Error('denied')));
    render(
      <CheckoutSessionDetail session={SESSION} orgId="o1" locale="es" signOutHref="/logout" />
    );
    await userEvent.click(screen.getByRole('button', { name: 'Copiar URL' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo copiar.');
  });

  it('has no structural accessibility violations (axe)', async () => {
    const { container } = render(
      <CheckoutSessionDetail session={SESSION} orgId="o1" locale="es" signOutHref="/logout" />
    );
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});
