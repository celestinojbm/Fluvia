import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { RefundDetail, RefundsList } from '../app/lib/refunds-view';
import type { Refund } from '../app/lib/api';

/**
 * F6.5A — vistas de reembolsos (jsdom + axe, CI-gated). SOLO LECTURA: crear un
 * reembolso hoy solo existe por API key (`payments:write`); la vista declara
 * el gap en vez de simular la acción.
 */

const REFUND: Refund = {
  id: 're_abcdef123456',
  payment_intent_id: 'pi_abcdef123456',
  amount: 40_000,
  currency: 'COP',
  status: 'succeeded',
  reason: 'requested_by_customer',
  failure_code: null,
  created_at: '2026-07-05T12:00:00Z',
};

describe('RefundsList', () => {
  it('lists refunds linking to detail and to the parent payment, and shows the empty state', () => {
    const { rerender } = render(
      <RefundsList refunds={[REFUND]} orgId="o1" locale="es" signOutHref="/logout" />
    );
    const refundLink = screen.getByRole('link', { name: /re_abcd/ });
    expect(refundLink.getAttribute('href')).toBe('/o/o1/refunds/re_abcdef123456');
    const paymentLink = screen.getByRole('link', { name: /pi_abcd/ });
    expect(paymentLink.getAttribute('href')).toBe('/o/o1/payments/pi_abcdef123456');
    expect(screen.getByText('$ 40.000')).toBeInTheDocument();

    rerender(<RefundsList refunds={[]} orgId="o1" locale="es" signOutHref="/logout" />);
    expect(screen.getByText('Sin reembolsos.')).toBeInTheDocument();
  });

  it('points to the payment detail for creation and renders no mutating controls', () => {
    render(<RefundsList refunds={[REFUND]} orgId="o1" locale="es" signOutHref="/logout" />);
    expect(
      screen.getByText(/Los reembolsos se crean desde el detalle del pago/)
    ).toBeInTheDocument();
    expect(screen.queryAllByRole('button')).toEqual([]);
  });
});

describe('RefundDetail', () => {
  it('renders the refund fields and links back to the payment', () => {
    render(<RefundDetail refund={REFUND} orgId="o1" locale="es" signOutHref="/logout" />);
    expect(screen.getByText('re_abcdef123456')).toBeInTheDocument();
    expect(screen.getByText('requested_by_customer')).toBeInTheDocument();
    const paymentLink = screen.getByRole('link', { name: /pi_abcdef123456/ });
    expect(paymentLink.getAttribute('href')).toBe('/o/o1/payments/pi_abcdef123456');
  });

  it('has no structural accessibility violations (axe)', async () => {
    const { container } = render(
      <RefundDetail refund={REFUND} orgId="o1" locale="es" signOutHref="/logout" />
    );
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});
