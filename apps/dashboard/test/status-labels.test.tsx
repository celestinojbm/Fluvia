import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { captureMethodLabel, StatusBadge, statusLabel } from '../app/lib/status-labels';
import { POS_REFUND_MESSAGES } from '../app/lib/pos-refund-messages';

/**
 * Estados en lenguaje del comercio: cada estado de las FSM tiene etiqueta en
 * es/en, las devoluciones usan EXACTAMENTE la palabra del POS, y un estado
 * desconocido se muestra tal cual (no se inventa un significado).
 */

const INTENT = [
  'created',
  'requires_payment_method',
  'requires_confirmation',
  'requires_action',
  'processing',
  'authorized',
  'partially_captured',
  'succeeded',
  'failed',
  'canceled',
  'partially_refunded',
  'refunded',
];
const REFUND = ['created', 'processing', 'indeterminate', 'succeeded', 'failed', 'canceled'];

describe('statusLabel', () => {
  it('labels every intent / session / link status in both locales (never the raw code)', () => {
    for (const locale of ['es', 'en'] as const) {
      for (const s of INTENT) expect(statusLabel('intent', s, locale)).not.toBe(s);
      for (const s of ['open', 'completed', 'expired'])
        expect(statusLabel('session', s, locale)).not.toBe(s);
      for (const s of ['active', 'disabled']) expect(statusLabel('link', s, locale)).not.toBe(s);
    }
  });

  it('refunds reuse the POS wording verbatim', () => {
    for (const locale of ['es', 'en'] as const)
      for (const s of REFUND)
        expect(statusLabel('refund', s, locale)).toBe(
          (POS_REFUND_MESSAGES[locale].status as Record<string, string>)[s]
        );
  });

  it('unknown statuses (and prototype keys) fall back to the raw code', () => {
    expect(statusLabel('intent', 'brand_new_state', 'es')).toBe('brand_new_state');
    expect(statusLabel('intent', 'toString', 'es')).toBe('toString');
    expect(captureMethodLabel('weird', 'es')).toBe('weird');
    expect(captureMethodLabel('automatic', 'es')).toBe('Automática');
  });
});

describe('StatusBadge', () => {
  it('keeps the technical code in data-status/title and shows it only on request', () => {
    const { rerender } = render(<StatusBadge kind="intent" status="succeeded" locale="es" />);
    const badge = screen.getByText('Aprobado');
    expect(badge).toHaveAttribute('data-status', 'succeeded');
    expect(badge).toHaveAttribute('title', 'succeeded');
    expect(badge).toHaveClass('badge', 'badge-succeeded');
    expect(screen.queryByText('succeeded')).toBeNull();

    rerender(<StatusBadge kind="intent" status="succeeded" locale="es" showCode />);
    expect(screen.getByText('succeeded').tagName).toBe('CODE');
  });
});
