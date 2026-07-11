import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { PaymentLinkDetail, PaymentLinksList } from '../app/lib/payment-links-view';
import type { PaymentLink } from '../app/lib/api';

/**
 * F6.5A — vistas de payment links (jsdom + axe, CI-gated). SOLO LECTURA +
 * copiar la URL sandbox. Crear/deshabilitar links hoy solo existe por API key;
 * la vista declara el gap en vez de simular la acción.
 */

const LINK: PaymentLink = {
  id: 'pl_abcdef123456',
  merchant_id: 'mer_112233445566',
  amount: 25_000,
  currency: 'COP',
  description: 'Mensualidad plan pro',
  status: 'active',
  url: 'http://localhost:3100/l/pl_abcdef123456',
  created_at: '2026-07-05T09:00:00Z',
  disabled_at: null,
};

afterEach(() => {
  delete (navigator as unknown as Record<string, unknown>).clipboard;
});

describe('PaymentLinksList', () => {
  it('lists links pointing to detail with formatted amounts, and shows the empty state', () => {
    const { rerender } = render(
      <PaymentLinksList links={[LINK]} orgId="o1" locale="es" signOutHref="/logout" />
    );
    const link = screen.getByRole('link', { name: /pl_abcd/ });
    expect(link.getAttribute('href')).toBe('/o/o1/payment-links/pl_abcdef123456');
    expect(screen.getByText('$ 25.000')).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();

    rerender(<PaymentLinksList links={[]} orgId="o1" locale="es" signOutHref="/logout" />);
    expect(screen.getByText('Sin payment links.')).toBeInTheDocument();
  });

  it('declares the create-link gap honestly and renders no mutating controls', () => {
    render(<PaymentLinksList links={[LINK]} orgId="o1" locale="es" signOutHref="/logout" />);
    expect(
      screen.getByText(/Crear payment links desde el panel aún no está disponible/)
    ).toBeInTheDocument();
    expect(screen.queryAllByRole('button')).toEqual([]);
  });
});

describe('PaymentLinkDetail', () => {
  it('renders the link fields and copies the sandbox URL to the clipboard', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    render(<PaymentLinkDetail link={LINK} orgId="o1" locale="es" signOutHref="/logout" />);
    expect(screen.getByText('pl_abcdef123456')).toBeInTheDocument();
    expect(screen.getByText('Mensualidad plan pro')).toBeInTheDocument();
    expect(screen.getByText('http://localhost:3100/l/pl_abcdef123456')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Copiar URL' }));
    expect(writeText).toHaveBeenCalledWith('http://localhost:3100/l/pl_abcdef123456');
    expect(await screen.findByText('Copiada ✓')).toBeInTheDocument();
  });

  it('has no structural accessibility violations (axe)', async () => {
    const { container } = render(
      <PaymentLinkDetail link={LINK} orgId="o1" locale="es" signOutHref="/logout" />
    );
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});
