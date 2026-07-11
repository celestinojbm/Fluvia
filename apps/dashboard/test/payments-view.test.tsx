import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import axe from 'axe-core';
import { PaymentDetail, PaymentsList } from '../app/lib/payments-view';
import type { CheckoutSession, PaymentIntent, Refund } from '../app/lib/api';

/**
 * F6.5A — vistas de pagos (jsdom + axe, CI-gated). Superficie SOLO LECTURA:
 * ningún rol ve controles mutantes aquí (el permiso `payments:read` lo tiene
 * todo rol; el API es la fuente de verdad). La línea de tiempo se deriva de
 * timestamps persistidos, en orden cronológico.
 */

const INTENT: PaymentIntent = {
  id: 'pi_abcdef123456',
  merchant_id: 'mer_112233445566',
  amount: 90_000,
  currency: 'COP',
  status: 'succeeded',
  capture_method: 'automatic',
  amount_captured: 90_000,
  amount_refunded: 40_000,
  failure_code: null,
  created_at: '2026-07-05T10:00:00Z',
};

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

const SESSION: CheckoutSession = {
  id: 'cs_abcdef123456',
  payment_intent_id: 'pi_abcdef123456',
  customer_id: null,
  status: 'completed',
  url: 'http://localhost:3100/c/cs_abcdef123456',
  success_url: null,
  cancel_url: null,
  expires_at: '2026-07-05T11:00:00Z',
  completed_at: '2026-07-05T10:30:00Z',
  created_at: '2026-07-05T10:05:00Z',
};

describe('PaymentsList', () => {
  it('lists payments linking to detail with formatted amounts, and shows the empty state', () => {
    const { rerender } = render(
      <PaymentsList intents={[INTENT]} orgId="o1" locale="es" signOutHref="/logout" />
    );
    const link = screen.getByRole('link', { name: /pi_abcd/ });
    expect(link.getAttribute('href')).toBe('/o/o1/payments/pi_abcdef123456');
    expect(screen.getByText('$ 90.000')).toBeInTheDocument();
    expect(screen.getByText('succeeded')).toBeInTheDocument();

    rerender(<PaymentsList intents={[]} orgId="o1" locale="es" signOutHref="/logout" />);
    expect(screen.getByText('Sin pagos.')).toBeInTheDocument();
  });

  it('is read-only for every role: no mutating controls rendered', () => {
    render(<PaymentsList intents={[INTENT]} orgId="o1" locale="es" signOutHref="/logout" />);
    expect(screen.queryAllByRole('button')).toEqual([]);
  });
});

describe('PaymentDetail', () => {
  it('renders the payment fields (captured/refunded) and links to related resources', () => {
    render(
      <PaymentDetail
        intent={INTENT}
        refunds={[REFUND]}
        sessions={[SESSION]}
        orgId="o1"
        locale="es"
        signOutHref="/logout"
      />
    );
    expect(screen.getByText('pi_abcdef123456')).toBeInTheDocument();
    expect(screen.getByText('automatic')).toBeInTheDocument();
    // Reembolso relacionado enlaza a su detalle; sesión relacionada al suyo.
    const refundLink = screen.getByRole('link', { name: /re_abcd/ });
    expect(refundLink.getAttribute('href')).toBe('/o/o1/refunds/re_abcdef123456');
    const sessionLink = screen.getByRole('link', { name: /cs_abcd/ });
    expect(sessionLink.getAttribute('href')).toBe('/o/o1/checkout-sessions/cs_abcdef123456');
    // Sin reconciliation:manage: hint honesto de rol, sin formulario.
    expect(screen.getByText(/Tu rol no permite crear reembolsos/)).toBeInTheDocument();
  });

  it('offers the create-refund form only to money-governing roles (canManage)', () => {
    render(
      <PaymentDetail
        intent={INTENT}
        refunds={[REFUND]}
        sessions={[SESSION]}
        orgId="o1"
        locale="es"
        signOutHref="/logout"
        canManage
      />
    );
    expect(screen.getByRole('button', { name: 'Crear reembolso' })).toBeInTheDocument();
    expect(screen.queryByText(/Tu rol no permite crear reembolsos/)).not.toBeInTheDocument();
  });

  it('derives the timeline chronologically from persisted timestamps', () => {
    render(
      <PaymentDetail
        intent={INTENT}
        refunds={[REFUND]}
        sessions={[SESSION]}
        orgId="o1"
        locale="es"
        signOutHref="/logout"
      />
    );
    const timeline = screen.getByRole('list');
    const items = within(timeline).getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual([
      expect.stringContaining('Pago creado'),
      expect.stringContaining('Sesión de checkout creada'),
      expect.stringContaining('Sesión de checkout completada'),
      expect.stringContaining('Reembolso creado'),
    ]);
  });

  it('renders no mutating controls for roles without reconciliation:manage', () => {
    render(
      <PaymentDetail
        intent={INTENT}
        refunds={[REFUND]}
        sessions={[SESSION]}
        orgId="o1"
        locale="es"
        signOutHref="/logout"
      />
    );
    expect(screen.queryAllByRole('button')).toEqual([]);
  });

  it('has no structural accessibility violations (axe)', async () => {
    const { container } = render(
      <PaymentDetail
        intent={INTENT}
        refunds={[REFUND]}
        sessions={[SESSION]}
        orgId="o1"
        locale="es"
        signOutHref="/logout"
      />
    );
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});
