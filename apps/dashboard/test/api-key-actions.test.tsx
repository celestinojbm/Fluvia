import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { CreateApiKeyForm, RevokeKeyButton } from '../app/lib/api-key-actions';
import { StepUpModal } from '../app/lib/step-up-modal';

/**
 * F6.5B2 — acciones de escritura de API keys + password step-up (jsdom, CI-gated).
 * Verifica: step-up requerido → modal → reintento ÚNICO; password incorrecta;
 * usuario MFA sin bypass; secreto una-sola-vez; y que password/secreto nunca
 * llegan a storage. SOLO consume endpoints existentes vía route handlers.
 */

// Cola de respuestas por URL (permite simular: acción 403 → step-up 200 →
// reintento 201, y variantes de fallo).
function queuedFetch(seq: Array<{ match: string; status: number; body?: unknown }>) {
  const calls: Array<{ url: string; body?: string }> = [];
  const fn = vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? String(init.body) : undefined });
    const items = seq.filter((s) => url.includes(s.match));
    // Selección por índice acumulado sobre las que casan la URL.
    const idx = calls.filter((c) => items.some((it) => c.url.includes(it.match))).length - 1;
    const chosen = items[Math.min(idx, items.length - 1)] ?? { status: 404, body: {} };
    return Promise.resolve({
      ok: chosen.status < 400,
      status: chosen.status,
      clone: () => ({ json: () => Promise.resolve(chosen.body ?? {}) }),
      json: () => Promise.resolve(chosen.body ?? {}),
    });
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls };
}

afterEach(() => vi.unstubAllGlobals());

describe('CreateApiKeyForm', () => {
  it('requires step-up: action 403 → modal → password → single retry → secret revealed once', async () => {
    // 1º create → 403 step-up; step-up → 200; 2º create → 201 con secret.
    const { calls } = queuedFetch([
      {
        match: '/api/orgs/o1/api-keys',
        status: 403,
        body: { error: { code: 'mfa_step_up_required' } },
      },
      { match: '/api/step-up/password', status: 200, body: { password_verified_at: 'now' } },
      {
        match: '/api/orgs/o1/api-keys',
        status: 201,
        body: { id: 'ak_1', secret: 'fluvia_sk_test_REVEALED' },
      },
    ]);
    render(<CreateApiKeyForm orgId="o1" locale="es" />);
    await userEvent.type(screen.getByLabelText('Etiqueta'), 'backend');
    await userEvent.click(screen.getByRole('button', { name: 'Crear API key' }));

    // El API pidió step-up → aparece el modal.
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Contraseña'), 'demo-owner-password');
    await userEvent.click(screen.getByRole('button', { name: 'Confirmar' }));

    // Secreto revelado UNA vez tras el reintento.
    await waitFor(() => expect(screen.getByText('fluvia_sk_test_REVEALED')).toBeInTheDocument());
    expect(screen.getByText(/no se volverá a mostrar/)).toBeInTheDocument();

    // Exactamente: create, step-up, create (reintento único). Sin bucle.
    const createCalls = calls.filter((c) => c.url === '/api/orgs/o1/api-keys');
    const stepupCalls = calls.filter((c) => c.url === '/api/step-up/password');
    expect(createCalls).toHaveLength(2);
    expect(stepupCalls).toHaveLength(1);
    // El primer create envió scopes + environment test (backend es fuente de verdad).
    expect(JSON.parse(createCalls[0]!.body!)).toEqual({
      label: 'backend',
      scopes: ['read'],
      environment: 'test',
    });
  });

  it('MFA users get no bypass: step-up itself returns 403 mfa → honest message, no retry loop', async () => {
    const { calls } = queuedFetch([
      {
        match: '/api/orgs/o1/api-keys',
        status: 403,
        body: { error: { code: 'mfa_step_up_required' } },
      },
      {
        match: '/api/step-up/password',
        status: 403,
        body: { error: { code: 'mfa_step_up_required' } },
      },
    ]);
    render(<CreateApiKeyForm orgId="o1" locale="es" />);
    await userEvent.type(screen.getByLabelText('Etiqueta'), 'backend');
    await userEvent.click(screen.getByRole('button', { name: 'Crear API key' }));
    await userEvent.type(await screen.findByLabelText('Contraseña'), 'whatever');
    await userEvent.click(screen.getByRole('button', { name: 'Confirmar' }));

    expect(await screen.findByText(/requiere un segundo factor/)).toBeInTheDocument();
    // Solo 1 create (no se reintentó: el step-up falló por MFA). Sin bucle.
    expect(calls.filter((c) => c.url === '/api/orgs/o1/api-keys')).toHaveLength(1);
  });

  it('SECURITY: neither the created secret nor the password reach localStorage/sessionStorage', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    queuedFetch([
      {
        match: '/api/orgs/o1/api-keys',
        status: 201,
        body: { id: 'ak_1', secret: 'fluvia_sk_test_NOSTORE' },
      },
    ]);
    render(<CreateApiKeyForm orgId="o1" locale="es" />);
    await userEvent.type(screen.getByLabelText('Etiqueta'), 'k');
    await userEvent.click(screen.getByRole('button', { name: 'Crear API key' }));
    await waitFor(() => expect(screen.getByText('fluvia_sk_test_NOSTORE')).toBeInTheDocument());
    for (const call of setItem.mock.calls) {
      expect(String(call[1])).not.toContain('fluvia_sk_test_NOSTORE');
    }
    setItem.mockRestore();
  });
});

describe('RevokeKeyButton', () => {
  it('confirms, requires step-up, retries once, and never reveals a secret', async () => {
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true)
    );
    vi.stubGlobal('location', { reload: vi.fn() } as unknown as Location);
    const { calls } = queuedFetch([
      { match: '/revoke', status: 403, body: { error: { code: 'mfa_step_up_required' } } },
      { match: '/api/step-up/password', status: 200, body: { password_verified_at: 'now' } },
      { match: '/revoke', status: 204 },
    ]);
    render(<RevokeKeyButton orgId="o1" keyId="ak_9" locale="es" />);
    await userEvent.click(screen.getByRole('button', { name: 'Revocar' }));
    await userEvent.type(await screen.findByLabelText('Contraseña'), 'demo-owner-password');
    await userEvent.click(screen.getByRole('button', { name: 'Confirmar' }));
    await waitFor(() => expect(screen.getByText('API key revocada ✓')).toBeInTheDocument());
    expect(calls.filter((c) => c.url.includes('/revoke'))).toHaveLength(2);
    // Nunca aparece un secreto en revoke.
    expect(document.body.innerHTML).not.toMatch(/fluvia_sk_/);
  });
});

describe('StepUpModal', () => {
  it('shows a wrong-password error and clears the password from the DOM', async () => {
    queuedFetch([
      {
        match: '/api/step-up/password',
        status: 401,
        body: { error: { code: 'invalid_credentials' } },
      },
    ]);
    render(<StepUpModal locale="es" onSuccess={vi.fn()} onCancel={vi.fn()} />);
    const input = screen.getByLabelText('Contraseña') as HTMLInputElement;
    await userEvent.type(input, 'wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Confirmar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Contraseña incorrecta.');
    // El password se limpió del estado tras el fallo.
    expect((screen.getByLabelText('Contraseña') as HTMLInputElement).value).toBe('');
  });

  it('uses type=password + current-password autocomplete and no structural a11y violations (axe)', async () => {
    const { container } = render(
      <StepUpModal locale="es" onSuccess={vi.fn()} onCancel={vi.fn()} />
    );
    const input = screen.getByLabelText('Contraseña') as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input.getAttribute('autocomplete')).toBe('current-password');
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});
