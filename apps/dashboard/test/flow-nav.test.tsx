import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import axe from 'axe-core';
import { FlowNav, flowHref } from '../app/lib/flow-nav';
import { PaymentDetail } from '../app/lib/payments-view';
import { DashboardView } from '../app/lib/dashboard-view';
import type { CheckoutSession, PaymentIntent } from '../app/lib/api';

/**
 * Continuidad del recorrido panel → cobrar → pagos → devoluciones: una sola
 * barra con «aquí estás», y desde el detalle de un pago se llega al
 * justificante (solo cobros confirmados) y al POS (su checkout más reciente).
 */

const INTENT: PaymentIntent = {
  id: 'pi_abcdef123456',
  merchant_id: 'mer_112233445566',
  amount: 90_000,
  currency: 'COP',
  status: 'succeeded',
  capture_method: 'automatic',
  amount_captured: 90_000,
  amount_refunded: 0,
  failure_code: null,
  created_at: '2026-07-05T10:00:00Z',
};
const session = (id: string, created_at: string): CheckoutSession => ({
  id,
  payment_intent_id: INTENT.id,
  customer_id: null,
  status: 'expired',
  url: null as unknown as string,
  success_url: null,
  cancel_url: null,
  expires_at: created_at,
  completed_at: null,
  created_at,
});

describe('FlowNav', () => {
  it('links the four flow sections, marks the current one and keeps the locale', () => {
    render(<FlowNav orgId="o1" locale="es" current="payments" />);
    const nav = screen.getByRole('navigation', { name: 'Recorrido del comercio' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((l) => [l.textContent, l.getAttribute('href')])).toEqual([
      ['Panel', '/o/o1'],
      ['Cobrar', '/o/o1/pos'],
      ['Pagos', '/o/o1/payments'],
      ['Devoluciones', '/o/o1/refunds'],
      ['Cerrar sesión', '/logout'],
    ]);
    expect(within(nav).getByRole('link', { name: 'Pagos' })).toHaveAttribute(
      'aria-current',
      'page'
    );
    expect(links.filter((l) => l.hasAttribute('aria-current'))).toHaveLength(1);
    expect(flowHref('o1', 'pos', 'en')).toBe('/o/o1/pos?lang=en');
  });

  it('has no structural accessibility violations (axe)', async () => {
    const { container } = render(<FlowNav orgId="o1" locale="en" current={null} />);
    const r = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(r.violations.map((v) => v.id)).toEqual([]);
  });

  it('the dashboard panel uses the same bar (current = panel)', () => {
    render(
      <DashboardView
        data={{ intents: [], refunds: [], sessions: [], links: [], webhookEvents: [] }}
        locale="es"
        orgId="o1"
        orgName="Org A"
        signOutHref="/logout"
      />
    );
    const nav = screen.getByRole('navigation', { name: 'Recorrido del comercio' });
    expect(within(nav).getByRole('link', { name: 'Panel' })).toHaveAttribute(
      'aria-current',
      'page'
    );
  });
});

describe('PaymentDetail → continuity', () => {
  const detail = (intent: PaymentIntent, sessions: CheckoutSession[]) =>
    render(
      <PaymentDetail
        intent={intent}
        refunds={[]}
        sessions={sessions}
        orgId="o1"
        locale="es"
        signOutHref="/logout"
      />
    );

  it('confirmed charge: receipt link + POS follows the MOST RECENT checkout', () => {
    detail(INTENT, [
      session('cs_old', '2026-07-05T10:01:00Z'),
      session('cs_new', '2026-07-05T10:09:00Z'),
    ]);
    expect(screen.getByTestId('payment-receipt-link')).toHaveAttribute(
      'href',
      '/o/o1/pos/receipts/pi_abcdef123456'
    );
    expect(screen.getByTestId('payment-pos-link')).toHaveAttribute(
      'href',
      '/o/o1/pos?session=cs_new'
    );
    // El enlace de vuelta dice a dónde lleva (antes: «Volver al panel» → lista).
    expect(screen.getByRole('link', { name: '← Volver a la lista' })).toHaveAttribute(
      'href',
      '/o/o1/payments'
    );
  });

  it('unconfirmed charge: no receipt is offered; no checkout: no POS link', () => {
    detail({ ...INTENT, status: 'failed', amount_captured: 0 }, []);
    expect(screen.queryByTestId('payment-receipt-link')).toBeNull();
    expect(screen.queryByTestId('payment-pos-link')).toBeNull();
  });
});
