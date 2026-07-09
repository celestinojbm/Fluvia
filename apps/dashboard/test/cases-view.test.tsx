import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import axe from 'axe-core';
import { CaseDetail, CasesList } from '../app/lib/cases-view';
import type { CaseAdjustment, OperationalCase, OperationalCaseDetail } from '../app/lib/api';

/**
 * F4-03c-ii — vistas de casos operativos + ajustes (jsdom + axe, CI-gated). Las
 * acciones son islas cliente; aquí se verifica el marcado, la VISIBILIDAD de
 * acciones por rol/estado (four-eyes) y la accesibilidad. El E2E de navegador
 * full-stack es local (el CI no tiene navegador).
 */

const CASE: OperationalCase = {
  id: 'case_abcdef123456',
  case_type: 'reconciliation_discrepancy',
  severity: 'critical',
  status: 'open',
  reconciliation_entry_id: 're_1',
  report_id: 'rep_1',
  provider: 'mock',
  provider_ref: 'ph-abc123',
  discrepancy_status: 'missing_in_ledger',
  ledger_amount: null,
  provider_amount: 9_000,
  assignee_user_id: null,
  resolution: null,
  resolved_by_user_id: null,
  version: 1,
  created_at: '2026-07-06T10:00:00Z',
  acknowledged_at: null,
  resolved_at: null,
};

const proposed: CaseAdjustment = {
  id: 'adj_1',
  case_id: CASE.id,
  amount: 9_000,
  currency: 'COP',
  direction: 'debit_differences',
  reason: 'cuadra la diferencia',
  status: 'proposed',
  requires_second_approval: true,
  proposed_by_user_id: 'user-1111',
  approved_by_user_id: null,
  rejected_by_user_id: null,
  rejection_reason: null,
  ledger_transaction_id: null,
  version: 1,
  created_at: '2026-07-06T10:01:00Z',
  decided_at: null,
};

const detail = (over: Partial<OperationalCaseDetail> = {}): OperationalCaseDetail => ({
  ...CASE,
  adjustments: [],
  ...over,
});

describe('CasesList', () => {
  it('lists cases linking to detail, shows filters and the empty state', () => {
    const { rerender } = render(
      <CasesList cases={[CASE]} orgId="o1" locale="es" activeStatus="open" signOutHref="/logout" />
    );
    const link = screen.getByRole('link', { name: /case_abc/ });
    expect(link.getAttribute('href')).toBe('/o/o1/cases/case_abcdef123456');
    // El filtro activo marca aria-current.
    expect(screen.getByRole('link', { name: 'Abiertos' }).getAttribute('aria-current')).toBe(
      'page'
    );
    // La severidad crítica se rotula.
    expect(screen.getByText('Crítica')).toBeInTheDocument();

    rerender(<CasesList cases={[]} orgId="o1" locale="es" signOutHref="/logout" />);
    expect(screen.getByText('Sin casos operativos.')).toBeInTheDocument();
  });
});

describe('CaseDetail — visibilidad de acciones por rol/estado', () => {
  it('a manager on an open case sees acknowledge, propose and resolve', () => {
    render(<CaseDetail kase={detail()} orgId="o1" locale="es" canManage signOutHref="/logout" />);
    expect(screen.getByRole('button', { name: 'Reconocer' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Proponer' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resolver (documental)' })).toBeInTheDocument();
    // El monto de la discrepancia siembra el formulario.
    expect(screen.getByLabelText('Monto')).toHaveValue(9_000);
  });

  it('a non-manager sees no actions (read-only)', () => {
    render(
      <CaseDetail
        kase={detail({ adjustments: [proposed] })}
        orgId="o1"
        locale="es"
        canManage={false}
        signOutHref="/logout"
      />
    );
    expect(screen.queryByRole('button', { name: 'Reconocer' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Proponer' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Aprobar' })).toBeNull();
    // Pero SÍ ve el ajuste (lectura).
    expect(screen.getByText('cuadra la diferencia')).toBeInTheDocument();
  });

  it('with a live proposed adjustment a manager sees approve/reject, not a new propose form', () => {
    render(
      <CaseDetail
        kase={detail({ status: 'acknowledged', adjustments: [proposed] })}
        orgId="o1"
        locale="es"
        canManage
        signOutHref="/logout"
      />
    );
    expect(screen.getByRole('button', { name: 'Aprobar' })).toBeInTheDocument();
    // No hay formulario de nueva propuesta (índice único parcial en la BD).
    expect(screen.queryByRole('button', { name: 'Proponer' })).toBeNull();
    expect(screen.getByText('Ya existe un ajuste vivo para este caso.')).toBeInTheDocument();
    // Ya reconocido → sin botón de reconocer.
    expect(screen.queryByRole('button', { name: 'Reconocer' })).toBeNull();
  });

  it('a resolved case shows no actions and its resolution note', () => {
    render(
      <CaseDetail
        kase={detail({ status: 'resolved', resolution: 'ajustado con asiento' })}
        orgId="o1"
        locale="es"
        canManage
        signOutHref="/logout"
      />
    );
    expect(screen.queryByRole('button', { name: 'Reconocer' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Proponer' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Resolver (documental)' })).toBeNull();
    expect(screen.getByText('ajustado con asiento')).toBeInTheDocument();
  });

  it('renders the applied adjustment amount formatted by currency', () => {
    render(
      <CaseDetail
        kase={detail({
          status: 'resolved',
          adjustments: [{ ...proposed, status: 'applied', ledger_transaction_id: 'tx_1' }],
        })}
        orgId="o1"
        locale="es"
        canManage={false}
        signOutHref="/logout"
      />
    );
    const table = screen.getByRole('table');
    expect(within(table).getByText('$ 9.000')).toBeInTheDocument();
  });

  it('has no structural accessibility violations (axe)', async () => {
    const { container } = render(
      <CaseDetail
        kase={detail({ status: 'acknowledged', adjustments: [proposed] })}
        orgId="o1"
        locale="es"
        canManage
        signOutHref="/logout"
      />
    );
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});
