import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PosWorkspace } from '../app/lib/pos-workspace';
import { joinRecentCharges } from '../app/lib/pos-reads';
import type { Merchant } from '../app/lib/api';

/**
 * POS — contenedor terminal + «Cobros recientes»: el panel se refresca cuando
 * el terminal ve un cambio de fase (sin recargar la página) y «Seguir» abre el
 * cobro en el terminal de la misma pantalla.
 */

const ORG = '1bfed2e0-1de8-52d5-9352-0cfd7e27a5e1';
const MERCHANT: Merchant = {
  id: 'd948f551-b02a-5154-97dc-9d9e39919cf3',
  name: 'Demo Store',
  country: 'CO',
  defaultCurrency: 'USD',
  status: 'active',
  createdAt: '2026-07-01T00:00:00Z',
};
const S1 = '00000000-0000-4000-8000-000000000001';
const S2 = '00000000-0000-4000-8000-000000000002';
const P1 = '11111111-0000-4000-8000-000000000001';
const P2 = '11111111-0000-4000-8000-000000000002';

const sess = (id: string, pi: string, status: string, min: number) => ({
  id,
  payment_intent_id: pi,
  status,
  expires_at: '2026-09-30T00:00:00Z',
  completed_at: null,
  created_at: `2026-09-29T10:0${min}:00Z`,
});
const pay = (id: string, status: string) => ({
  id,
  merchant_id: MERCHANT.id,
  amount: 1250,
  currency: 'USD',
  status,
  failure_code: status === 'failed' ? 'card_declined' : null,
  amount_refunded: 0,
});
const res = (s: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status: s }));

afterEach(() => vi.unstubAllGlobals());

describe('PosWorkspace', () => {
  it('fase nueva en el terminal ⇒ la lista se refresca; «Seguir» abre otro cobro aquí', async () => {
    const statusBySession: Record<string, unknown> = {
      [S1]: { session: sess(S1, P1, 'open', 1), payment: pay(P1, 'succeeded') },
      [S2]: { session: sess(S2, P2, 'open', 2), payment: pay(P2, 'failed') },
    };
    const f = vi.fn((url: string) => {
      if (url.endsWith('/pos/recent')) {
        return res(
          200,
          joinRecentCharges(
            [sess(S1, P1, 'completed', 1), sess(S2, P2, 'open', 2)],
            [pay(P1, 'succeeded'), pay(P2, 'failed')]
          )
        );
      }
      const m = url.match(/\/pos\/sessions\/([^/]+)$/);
      if (m) return res(200, statusBySession[m[1]!]);
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal('fetch', f);

    // Estado inicial del servidor: S1 aún «esperando» (lectura anterior al pago).
    render(
      <PosWorkspace
        orgId={ORG}
        locale="es"
        merchants={[MERCHANT]}
        allMerchants={[{ id: MERCHANT.id, name: MERCHANT.name }]}
        canCharge
        resume={{ sessionId: S1, linkId: null }}
        recent={joinRecentCharges([sess(S1, P1, 'open', 1)], [pay(P1, 'requires_payment_method')])}
      />
    );

    // El terminal ve «aprobado» ⇒ el panel se refresca solo y lo refleja.
    await waitFor(() =>
      expect(screen.getByTestId('pos-phase')).toHaveAttribute('data-phase', 'succeeded')
    );
    await waitFor(() =>
      expect(f.mock.calls.some((c) => String(c[0]).endsWith('/pos/recent'))).toBe(true)
    );
    const list = await screen.findByRole('list');
    await within(list).findByText('Pago aprobado', { selector: '.badge' });
    // Fila del cobro en seguimiento marcada.
    const current = within(list)
      .getAllByRole('listitem')
      .find((li) => li.getAttribute('aria-current'));
    expect(current).toBeDefined();

    // «Seguir» otro cobro: el terminal lo abre en esta misma pantalla.
    const row2 = within(list)
      .getAllByRole('listitem')
      .find((li) => within(li).queryByText('Pago rechazado', { selector: '.badge' }))!;
    await userEvent.click(within(row2).getByRole('link', { name: /^Seguir/ }));
    await waitFor(() =>
      expect(screen.getByTestId('pos-phase')).toHaveAttribute('data-phase', 'failed')
    );
    expect(f.mock.calls.some((c) => String(c[0]).endsWith(`/pos/sessions/${S2}`))).toBe(true);
    expect(window.location.search).toContain(`session=${S2}`);
  });
});
