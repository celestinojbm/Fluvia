import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { ReconciliationDetail, ReconciliationList } from '../app/lib/reconciliation-view';
import { fetchReconciliationEntries, fetchSettlementReports } from '../app/lib/api';
import type { ReconciliationEntry, SettlementReport } from '../app/lib/api';

/**
 * F4-01c — vistas de conciliación (jsdom + axe, CI-gated) + lógica pura de los
 * fetchers. El E2E de navegador full-stack es local.
 */

const REPORT: SettlementReport = {
  id: 'rep_abcdef123456',
  provider: 'mock',
  currency: 'COP',
  period_start: '2026-06-01T00:00:00Z',
  period_end: '2026-07-01T00:00:00Z',
  status: 'reconciled',
  created_at: '2026-07-05T10:00:00Z',
  reconciled_at: '2026-07-05T10:05:00Z',
  summary: { matched: 3, amount_mismatch: 1, missing_in_ledger: 2, missing_at_provider: 0 },
};

const ENTRIES: ReconciliationEntry[] = [
  {
    provider_ref: 'ref_bad',
    status: 'missing_in_ledger',
    ledger_amount: null,
    provider_amount: 15_000,
    payment_intent_id: null,
  },
];

describe('ReconciliationList', () => {
  it('lists reports linking to detail, and shows the empty state', () => {
    const { rerender } = render(
      <ReconciliationList
        reports={[REPORT]}
        orgId="o1"
        locale="es"
        signOutHref="/logout"
      />
    );
    const link = screen.getByRole('link', { name: /rep_abcd/ });
    expect(link.getAttribute('href')).toBe('/o/o1/reconciliation/rep_abcdef123456');

    rerender(
      <ReconciliationList reports={[]} orgId="o1" locale="es" signOutHref="/logout" />
    );
    expect(screen.getByText('Sin reportes de liquidación.')).toBeInTheDocument();
  });
});

describe('ReconciliationDetail', () => {
  it('renders the summary counts and the discrepancy rows', () => {
    render(
      <ReconciliationDetail
        report={REPORT}
        entries={ENTRIES}
        orgId="o1"
        locale="es"
        signOutHref="/logout"
      />
    );
    // Resumen: conciliados=3, falta en el ledger=2.
    expect(screen.getByText('Conciliados').previousSibling?.textContent).toBe('3');
    expect(screen.getByText('missing_in_ledger')).toBeInTheDocument();
    // Monto del proveedor formateado (COP).
    expect(screen.getByText('$ 15.000')).toBeInTheDocument();
  });

  it('has no structural accessibility violations (axe)', async () => {
    const { container } = render(
      <ReconciliationDetail
        report={REPORT}
        entries={ENTRIES}
        orgId="o1"
        locale="es"
        signOutHref="/logout"
      />
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

describe('reconciliation fetchers', () => {
  it('fetchSettlementReports returns the list and degrades to [] on error', async () => {
    const ok = await fetchSettlementReports({
      apiBase: 'http://api',
      token: 't',
      orgId: 'o1',
      fetchImpl: fakeFetch(200, { data: [REPORT] }),
    });
    expect(ok).toHaveLength(1);
    const bad = await fetchSettlementReports({
      apiBase: 'http://api',
      token: 't',
      orgId: 'o1',
      fetchImpl: fakeFetch(500, {}),
    });
    expect(bad).toEqual([]);
  });

  it('fetchReconciliationEntries passes the status filter', async () => {
    const spy = fakeFetch(200, { data: ENTRIES });
    await fetchReconciliationEntries({
      apiBase: 'http://api',
      token: 't',
      orgId: 'o1',
      reportId: 'r1',
      status: 'missing_in_ledger',
      fetchImpl: spy,
    });
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('/entries?status=missing_in_ledger'),
      expect.anything()
    );
  });
});
