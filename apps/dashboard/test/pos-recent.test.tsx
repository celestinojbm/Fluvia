import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import axe from 'axe-core';
import type { CheckoutSession, PaymentIntent } from '../app/lib/api';
import { fetchRecentCharges, joinRecentCharges, RECENT_ROWS } from '../app/lib/pos-reads';
import { PosRecentCharges } from '../app/lib/pos-recent';

/**
 * POS — cobros recientes: unión REAL sesión↔intent por `payment_intent_id`,
 * error de lectura distinto de «vacío», y vista accesible.
 */

const ORG = '1bfed2e0-1de8-52d5-9352-0cfd7e27a5e1';

function session(n: number, intentId: string, status = 'open'): CheckoutSession {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    payment_intent_id: intentId,
    customer_id: null,
    status,
    url: 'u',
    success_url: null,
    cancel_url: null,
    expires_at: '2026-09-30T00:00:00Z',
    completed_at: null,
    created_at: `2026-09-29T10:${String(n).padStart(2, '0')}:00Z`,
  };
}
function intent(id: string, status: string, amount = 1250): PaymentIntent {
  return {
    id,
    merchant_id: 'm',
    amount,
    currency: 'USD',
    status,
    capture_method: 'automatic',
    amount_captured: 0,
    amount_refunded: 0,
    failure_code: null,
    created_at: '2026-09-29T10:00:00Z',
  };
}

describe('joinRecentCharges', () => {
  it('une por payment_intent_id, ordena por fecha desc y acota', () => {
    const sessions = Array.from({ length: 14 }, (_, i) => session(i, `pi-${i}`));
    const rows = joinRecentCharges(sessions, [
      intent('pi-13', 'succeeded'),
      intent('pi-12', 'failed'),
    ]);
    expect(rows).toHaveLength(RECENT_ROWS);
    expect(rows[0]!.session.payment_intent_id).toBe('pi-13');
    expect(rows[0]!.payment?.status).toBe('succeeded');
    expect(rows[1]!.payment?.status).toBe('failed');
    // Intent fuera de la página leída: null, jamás un pago inventado.
    expect(rows[2]!.payment).toBeNull();
  });
});

describe('fetchRecentCharges', () => {
  const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });

  it('lee sesiones e intents por el plano de sesión con Bearer', async () => {
    const f = vi.fn((url: string) =>
      Promise.resolve(
        url.includes('checkout_sessions')
          ? ok([session(1, 'pi-1')])
          : ok([intent('pi-1', 'created')])
      )
    );
    const r = await fetchRecentCharges({
      apiBase: 'http://api',
      token: 't',
      orgId: ORG,
      fetchImpl: f as never,
    });
    expect(r.ok).toBe(true);
    expect(f.mock.calls.map((c) => c[0])).toEqual([
      `http://api/v1/organizations/${ORG}/checkout_sessions?limit=25`,
      `http://api/v1/organizations/${ORG}/payment_intents?limit=100`,
    ]);
    expect((f.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toEqual({
      authorization: 'Bearer t',
    });
  });

  it('un fallo de cualquiera de las lecturas es error, no historial vacío', async () => {
    for (const bad of [
      () => Promise.reject(new Error('down')),
      () => Promise.resolve(new Response('{}', { status: 500 })),
      () => Promise.resolve(new Response('{"nodata":1}', { status: 200 })),
    ]) {
      const f = vi.fn((url: string) =>
        url.includes('payment_intents') ? bad() : Promise.resolve(ok([]))
      );
      expect(
        await fetchRecentCharges({
          apiBase: 'http://api',
          token: 't',
          orgId: ORG,
          fetchImpl: f as never,
        })
      ).toEqual({ ok: false });
    }
  });
});

describe('PosRecentCharges', () => {
  it('muestra fases derivadas y enlaces a seguir/detalle (axe)', async () => {
    const s = session(1, 'pi-1', 'completed');
    const { container } = render(
      <PosRecentCharges
        result={{ ok: true, rows: [{ session: s, payment: intent('pi-1', 'succeeded') }] }}
        orgId={ORG}
        locale="es"
      />
    );
    expect(screen.getByText('Pago aprobado')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Seguir/ })).toHaveAttribute(
      'href',
      `/o/${ORG}/pos?session=${s.id}`
    );
    expect(screen.getByRole('link', { name: /^Detalle/ })).toHaveAttribute(
      'href',
      `/o/${ORG}/payments/pi-1`
    );
    const r = await axe.run(container);
    expect(r.violations).toEqual([]);
  });

  it('estados vacío y error son distintos', () => {
    const { rerender } = render(
      <PosRecentCharges result={{ ok: true, rows: [] }} orgId={ORG} locale="es" />
    );
    expect(screen.getByText(/Aún no hay cobros/)).toBeInTheDocument();
    rerender(<PosRecentCharges result={{ ok: false }} orgId={ORG} locale="es" />);
    expect(screen.getByRole('alert')).toHaveTextContent('No pudimos cargar');
  });
});
