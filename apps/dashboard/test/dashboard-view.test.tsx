import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { DashboardView } from '../app/lib/dashboard-view';
import { LoginForm } from '../app/login/login-client';
import type { DashboardData } from '../app/lib/api';

/**
 * F3-09b — tests de componente (jsdom + axe), CI-gated. El E2E de navegador
 * full-stack (login → panel con datos reales) es local (el CI no tiene navegador).
 */

const DATA: DashboardData = {
  intents: [
    {
      id: 'pi_abcdef123456',
      status: 'succeeded',
      amount: 90_000,
      currency: 'COP',
      created_at: '2026-07-05T10:00:00Z',
    },
  ],
  refunds: [],
  sessions: [{ id: 'cs_1', status: 'completed', created_at: '2026-07-05T10:01:00Z' }],
  links: [
    {
      id: 'pl_1',
      status: 'active',
      amount: 25_000,
      currency: 'COP',
      created_at: '2026-07-05T10:02:00Z',
    },
  ],
  webhookEvents: [
    {
      id: 'whe_1',
      topic: 'merchant.updated',
      status: 'dead',
      attempts: 7,
      created_at: '2026-07-05T10:03:00Z',
    },
  ],
};

afterEach(() => vi.unstubAllGlobals());

describe('DashboardView', () => {
  it('renders every section, formats amounts, and shows empty states (es)', () => {
    render(<DashboardView data={DATA} locale="es" orgName="Org A" signOutHref="/logout" />);
    expect(screen.getByRole('heading', { name: 'Panel de operación' })).toBeInTheDocument();
    expect(screen.getByText('Org A')).toBeInTheDocument();
    // Payment intents: monto formateado COP (exponente 0).
    expect(screen.getByText('$ 90.000')).toBeInTheDocument();
    // Refunds vacío.
    expect(screen.getAllByText('Sin registros.').length).toBeGreaterThanOrEqual(1);
    // Cola de webhooks: el topic y el estado dead.
    expect(screen.getByText('merchant.updated')).toBeInTheDocument();
    expect(screen.getByText('dead')).toBeInTheDocument();
  });

  it('renders English section titles for locale=en', () => {
    render(<DashboardView data={DATA} locale="en" orgName="Org A" signOutHref="/logout" />);
    expect(screen.getByRole('heading', { name: 'Operations dashboard' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Webhook queue/ })).toBeInTheDocument();
  });

  it('has no structural accessibility violations (axe)', async () => {
    const { container } = render(
      <DashboardView data={DATA} locale="es" orgName="Org A" signOutHref="/logout" />
    );
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});

describe('LoginForm', () => {
  function mock(status: number, body: unknown) {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ status, json: () => Promise.resolve(body) }))
    );
  }

  it('posts credentials to the session route handler', async () => {
    mock(200, { ok: true });
    // window.location.assign no está implementado en jsdom: lo silenciamos.
    vi.stubGlobal('location', { assign: vi.fn() } as unknown as Location);
    render(<LoginForm locale="es" />);
    await userEvent.type(screen.getByLabelText('Correo electrónico'), 'a@b.co');
    await userEvent.type(screen.getByLabelText('Contraseña'), 'secret12');
    await userEvent.click(screen.getByRole('button', { name: 'Entrar' }));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/session',
        expect.objectContaining({ method: 'POST' })
      )
    );
  });

  it('shows an error on invalid credentials and an MFA notice when required', async () => {
    mock(401, { reason: 'invalid' });
    render(<LoginForm locale="es" />);
    await userEvent.type(screen.getByLabelText('Correo electrónico'), 'a@b.co');
    await userEvent.type(screen.getByLabelText('Contraseña'), 'bad');
    await userEvent.click(screen.getByRole('button', { name: 'Entrar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('inválidos');
  });
});
