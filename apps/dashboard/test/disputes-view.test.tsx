import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { DisputesDetail, DisputesList } from '../app/lib/disputes-view';
import { fetchDispute, fetchDisputes } from '../app/lib/api';
import type { Dispute } from '../app/lib/api';

/**
 * F4-08d — vistas de disputas (jsdom + axe, CI-gated) + lógica pura de los
 * fetchers. Solo lectura; el E2E de navegador full-stack es local.
 */

const WON: Dispute = {
  id: 'dp_abcdef123456',
  merchant_id: 'mer_112233445566',
  amount: 30_000,
  currency: 'COP',
  status: 'won',
  reason: 'fraudulent',
  provider_ref: 'bank_dp_1',
  created_at: '2026-07-06T10:00:00Z',
};

const OPEN: Dispute = {
  id: 'dp_zzzzzz999999',
  merchant_id: 'mer_112233445566',
  amount: 40_000,
  currency: 'COP',
  status: 'open',
  reason: 'product_not_received',
  provider_ref: 'bank_dp_2',
  created_at: '2026-07-06T11:00:00Z',
};

describe('DisputesList', () => {
  it('lists disputes linking to detail with formatted amounts, and shows the empty state', () => {
    const { rerender } = render(
      <DisputesList disputes={[WON]} orgId="o1" locale="es" signOutHref="/logout" />
    );
    const link = screen.getByRole('link', { name: /dp_abcd/ });
    expect(link.getAttribute('href')).toBe('/o/o1/disputes/dp_abcdef123456');
    expect(screen.getByText('$ 30.000')).toBeInTheDocument();
    expect(screen.getByText('won')).toBeInTheDocument();

    rerender(<DisputesList disputes={[]} orgId="o1" locale="es" signOutHref="/logout" />);
    expect(screen.getByText('Sin disputas.')).toBeInTheDocument();
  });
});

describe('DisputesDetail', () => {
  it('renders the dispute fields and the held hint only while not terminal', () => {
    const { rerender } = render(
      <DisputesDetail dispute={WON} orgId="o1" locale="es" signOutHref="/logout" />
    );
    expect(screen.getByText('dp_abcdef123456')).toBeInTheDocument();
    expect(screen.getByText('bank_dp_1')).toBeInTheDocument();
    // won (terminal) => sin la pista de fondos apartados.
    expect(screen.queryByText(/Fondos apartados/)).not.toBeInTheDocument();

    rerender(<DisputesDetail dispute={OPEN} orgId="o1" locale="es" signOutHref="/logout" />);
    expect(screen.getByText(/Fondos apartados/)).toBeInTheDocument();
    expect(screen.getByText('product_not_received')).toBeInTheDocument();
  });

  it('has no structural accessibility violations (axe)', async () => {
    const { container } = render(
      <DisputesDetail dispute={OPEN} orgId="o1" locale="es" signOutHref="/logout" />
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

describe('dispute fetchers', () => {
  it('fetchDisputes returns the list and degrades to [] on error', async () => {
    const ok = await fetchDisputes({
      apiBase: 'http://api',
      token: 't',
      orgId: 'o1',
      fetchImpl: fakeFetch(200, { data: [WON] }),
    });
    expect(ok).toHaveLength(1);
    const bad = await fetchDisputes({
      apiBase: 'http://api',
      token: 't',
      orgId: 'o1',
      fetchImpl: fakeFetch(500, {}),
    });
    expect(bad).toEqual([]);
  });

  it('fetchDispute returns the object, or null on not-found', async () => {
    const ok = await fetchDispute({
      apiBase: 'http://api',
      token: 't',
      orgId: 'o1',
      disputeId: 'dp_abcdef123456',
      fetchImpl: fakeFetch(200, WON),
    });
    expect(ok?.id).toBe('dp_abcdef123456');
    const missing = await fetchDispute({
      apiBase: 'http://api',
      token: 't',
      orgId: 'o1',
      disputeId: 'nope',
      fetchImpl: fakeFetch(404, {}),
    });
    expect(missing).toBeNull();
  });
});
