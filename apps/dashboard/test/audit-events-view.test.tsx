import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { AuditEventsList } from '../app/lib/audit-events-view';
import type { AuditEvent } from '../app/lib/api';

/**
 * F4-04b — vista «ver eventos» del panel admin (jsdom + axe, CI-gated). Verifica
 * el marcado, los badges de resultado/riesgo, la paginación por cursor y el
 * estado vacío. El E2E de navegador full-stack es local.
 */

const EVENTS: AuditEvent[] = [
  {
    id: '100',
    actor_type: 'user',
    actor_id: 'user-1111',
    auth_method: 'session',
    action: 'operational_case.resolved',
    resource_type: 'operational_case',
    resource_id: 'case_abcdef123456',
    result: 'success',
    risk_level: 'medium',
    reason: null,
    request_id: 'req_1',
    created_at: '2026-07-06T10:00:00Z',
  },
  {
    id: '99',
    actor_type: 'api_key',
    actor_id: 'key-2222',
    auth_method: 'api_key',
    action: 'payment_intent.created',
    resource_type: null,
    resource_id: null,
    result: 'failure',
    risk_level: 'high',
    reason: 'denied',
    request_id: 'req_2',
    created_at: '2026-07-06T09:59:00Z',
  },
];

describe('AuditEventsList', () => {
  it('renders events with translated result/risk badges and an older-cursor link', () => {
    render(
      <AuditEventsList
        events={EVENTS}
        nextBefore="99"
        orgId="o1"
        locale="es"
        signOutHref="/logout"
      />
    );
    expect(screen.getByText('operational_case.resolved')).toBeInTheDocument();
    expect(screen.getByText('Éxito')).toBeInTheDocument();
    expect(screen.getByText('Fallo')).toBeInTheDocument();
    // Riesgo reutiliza las etiquetas de severidad.
    expect(screen.getByText('Media')).toBeInTheDocument();
    expect(screen.getByText('Alta')).toBeInTheDocument();
    // Paginación por cursor.
    const older = screen.getByRole('link', { name: 'Ver más antiguos →' });
    expect(older.getAttribute('href')).toBe('/o/o1/events?before=99');
  });

  it('omits the older link when there is no cursor and shows the empty state', () => {
    const { rerender } = render(
      <AuditEventsList
        events={EVENTS}
        nextBefore={null}
        orgId="o1"
        locale="es"
        signOutHref="/logout"
      />
    );
    expect(screen.queryByRole('link', { name: 'Ver más antiguos →' })).toBeNull();

    rerender(
      <AuditEventsList events={[]} nextBefore={null} orgId="o1" locale="es" signOutHref="/logout" />
    );
    expect(screen.getByText('Sin eventos de auditoría.')).toBeInTheDocument();
  });

  it('carries the lang param into the older-cursor link (en)', () => {
    render(
      <AuditEventsList
        events={EVENTS}
        nextBefore="99"
        orgId="o1"
        locale="en"
        signOutHref="/logout"
      />
    );
    expect(screen.getByRole('link', { name: 'Older →' }).getAttribute('href')).toBe(
      '/o/o1/events?lang=en&before=99'
    );
  });

  it('has no structural accessibility violations (axe)', async () => {
    const { container } = render(
      <AuditEventsList
        events={EVENTS}
        nextBefore="99"
        orgId="o1"
        locale="es"
        signOutHref="/logout"
      />
    );
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});
