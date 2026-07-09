import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { PayoutsDetail, PayoutsList } from '../app/lib/payouts-view';
import { fetchPayout, fetchPayouts } from '../app/lib/api';
import type { Payout } from '../app/lib/api';

/**
 * F4-07d — vistas de payouts (jsdom + axe, CI-gated) + lógica pura de los
 * fetchers. Solo lectura; el E2E de navegador full-stack es local.
 */

const PAID: Payout = {
  id: 'po_abcdef123456',
  merchant_id: 'mer_112233445566',
  amount: 40_000,
  currency: 'COP',
  status: 'paid',
  reason: null,
  failure_code: null,
  created_at: '2026-07-06T10:00:00Z',
};

const INDETERMINATE: Payout = {
  id: 'po_zzzzzz999999',
  merchant_id: 'mer_112233445566',
  amount: 90_000,
  currency: 'COP',
  status: 'indeterminate',
  reason: 'weekly payout',
  failure_code: null,
  created_at: '2026-07-06T11:00:00Z',
};

describe('PayoutsList', () => {
  it('lists payouts linking to detail with formatted amounts, and shows the empty state', () => {
    const { rerender } = render(
      <PayoutsList payouts={[PAID]} orgId="o1" locale="es" signOutHref="/logout" />
    );
    const link = screen.getByRole('link', { name: /po_abcd/ });
    expect(link.getAttribute('href')).toBe('/o/o1/payouts/po_abcdef123456');
    expect(screen.getByText('$ 40.000')).toBeInTheDocument();
    expect(screen.getByText('paid')).toBeInTheDocument();

    rerender(<PayoutsList payouts={[]} orgId="o1" locale="es" signOutHref="/logout" />);
    expect(screen.getByText('Sin payouts.')).toBeInTheDocument();
  });
});

describe('PayoutsDetail', () => {
  it('renders the payout fields and the indeterminate hint only when indeterminate', () => {
    const { rerender } = render(
      <PayoutsDetail payout={PAID} orgId="o1" locale="es" signOutHref="/logout" />
    );
    expect(screen.getByText('po_abcdef123456')).toBeInTheDocument();
    expect(screen.getAllByText('$ 40.000').length).toBeGreaterThanOrEqual(1);
    // paid => sin la pista de indeterminado.
    expect(screen.queryByText(/fondos retenidos en tránsito/)).not.toBeInTheDocument();

    rerender(<PayoutsDetail payout={INDETERMINATE} orgId="o1" locale="es" signOutHref="/logout" />);
    expect(screen.getByText(/fondos retenidos en tránsito/)).toBeInTheDocument();
    expect(screen.getByText('weekly payout')).toBeInTheDocument();
  });

  it('has no structural accessibility violations (axe)', async () => {
    const { container } = render(
      <PayoutsDetail payout={INDETERMINATE} orgId="o1" locale="es" signOutHref="/logout" />
    );
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});

function fakeFetch(status: number, body: unknown): typeof fetch {
  return vi.fn(() =>
    Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) })
  ) as unknown as typeof fetch;
}

describe('payout fetchers', () => {
  it('fetchPayouts returns the list and degrades to [] on error', async () => {
    const ok = await fetchPayouts({
      apiBase: 'http://api',
      token: 't',
      orgId: 'o1',
      fetchImpl: fakeFetch(200, { data: [PAID] }),
    });
    expect(ok).toHaveLength(1);
    const bad = await fetchPayouts({
      apiBase: 'http://api',
      token: 't',
      orgId: 'o1',
      fetchImpl: fakeFetch(500, {}),
    });
    expect(bad).toEqual([]);
  });

  it('fetchPayout returns the object, or null on not-found', async () => {
    const ok = await fetchPayout({
      apiBase: 'http://api',
      token: 't',
      orgId: 'o1',
      payoutId: 'po_abcdef123456',
      fetchImpl: fakeFetch(200, PAID),
    });
    expect(ok?.id).toBe('po_abcdef123456');
    const missing = await fetchPayout({
      apiBase: 'http://api',
      token: 't',
      orgId: 'o1',
      payoutId: 'nope',
      fetchImpl: fakeFetch(404, {}),
    });
    expect(missing).toBeNull();
  });
});
