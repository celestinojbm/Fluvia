import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { SignupForm } from '../app/signup/signup-client';
import { LoginForm } from '../app/login/login-client';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../app/lib/csrf-header';

/**
 * F6.5C1 — UI de signup sandbox (jsdom + axe, CI-gated). Render accesible,
 * copy SANDBOX visible, mismatch de password bloquea el submit SIN red,
 * anti doble-submit, exito => redirige a /login (sin auto-login), error
 * estable con foco, y enlaces login<->signup.
 */

function stubFetch(status: number, body: unknown, delayMs = 0) {
  const fn = vi.fn(
    (_url: string, _init?: RequestInit) =>
      new Promise<Response>((resolve) =>
        setTimeout(() => resolve(new Response(JSON.stringify(body), { status })), delayMs)
      )
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

const EMAIL = 'nueva@example.com';
const PASSWORD = 'sandbox password 12';

async function fillForm(password = PASSWORD, confirm = PASSWORD) {
  await userEvent.type(screen.getByLabelText('Correo electrónico'), EMAIL);
  await userEvent.type(screen.getByLabelText('Contraseña'), password);
  await userEvent.type(screen.getByLabelText('Confirmar contraseña'), confirm);
}

describe('SignupForm', () => {
  it('renders accessibly with labelled fields and the SANDBOX copy (axe clean)', async () => {
    const { container } = render(<SignupForm locale="es" navigate={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Crear cuenta' })).toBeInTheDocument();
    expect(screen.getByLabelText('Correo electrónico')).toBeInTheDocument();
    expect(screen.getByLabelText('Contraseña')).toBeInTheDocument();
    expect(screen.getByLabelText('Confirmar contraseña')).toBeInTheDocument();
    // Indicador de verificacion simulada + aviso de que no hay correo real.
    expect(screen.getByText('Verificación de email simulada — SANDBOX')).toBeInTheDocument();
    expect(screen.getByText(/No se envía ningún correo real/)).toBeInTheDocument();
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });

  it('password mismatch blocks the submit: accessible error, focus on it, NO network call', async () => {
    const fetchFn = stubFetch(201, {});
    render(<SignupForm locale="es" navigate={vi.fn()} />);
    await fillForm(PASSWORD, 'otra password distinta 9');
    await userEvent.click(screen.getByRole('button', { name: 'Crear cuenta' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Las contraseñas no coinciden.');
    await waitFor(() => expect(alert).toHaveFocus());
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('success: single POST to /api/signup with the CSRF header, then redirect to /login (no auto-login)', async () => {
    const fetchFn = stubFetch(201, { registered: true, email_verified: true });
    const navigate = vi.fn();
    render(<SignupForm locale="es" navigate={navigate} />);
    await fillForm();
    await userEvent.click(screen.getByRole('button', { name: 'Crear cuenta' }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/login'));
    // Exactamente UNA llamada, solo al proxy de signup — jamas /api/session.
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/signup');
    expect((init.headers as Record<string, string>)[CSRF_HEADER]).toBe(CSRF_HEADER_VALUE);
    expect(JSON.parse(String(init.body))).toEqual({ email: EMAIL, password: PASSWORD });
    expect(navigate).not.toHaveBeenCalledWith('/');
  });

  it('prevents double submit: two clicks while in flight => one request', async () => {
    const fetchFn = stubFetch(201, { registered: true }, 50);
    render(<SignupForm locale="es" navigate={vi.fn()} />);
    await fillForm();
    const button = screen.getByRole('button', { name: 'Crear cuenta' });
    await userEvent.click(button);
    // En vuelo: deshabilitado y con estado de carga visible.
    expect(screen.getByRole('button', { name: 'Creando cuenta…' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Creando cuenta…' }));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
  });

  it('stable error for duplicate email (409 email_taken) with focus on the alert', async () => {
    stubFetch(409, { ok: false, error: { code: 'email_taken' } });
    render(<SignupForm locale="es" navigate={vi.fn()} />);
    await fillForm();
    await userEvent.click(screen.getByRole('button', { name: 'Crear cuenta' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Ya existe una cuenta con este correo.');
    await waitFor(() => expect(alert).toHaveFocus());
    // El formulario vuelve a estar operable (sin loading atascado).
    expect(screen.getByRole('button', { name: 'Crear cuenta' })).toBeEnabled();
  });

  it('generic stable error on network failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('boom')))
    );
    render(<SignupForm locale="es" navigate={vi.fn()} />);
    await fillForm();
    await userEvent.click(screen.getByRole('button', { name: 'Crear cuenta' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No se pudo crear la cuenta. Inténtalo de nuevo.'
    );
  });

  it('links back to /login (and preserves lang=en)', () => {
    const { unmount } = render(<SignupForm locale="es" navigate={vi.fn()} />);
    expect(screen.getByRole('link', { name: '← Volver a iniciar sesión' })).toHaveAttribute(
      'href',
      '/login'
    );
    unmount();
    render(<SignupForm locale="en" navigate={vi.fn()} />);
    expect(screen.getByRole('link', { name: '← Back to sign in' })).toHaveAttribute(
      'href',
      '/login?lang=en'
    );
  });
});

describe('LoginForm — enlace hacia signup', () => {
  it('links to /signup (and preserves lang=en)', () => {
    const { unmount } = render(<LoginForm locale="es" />);
    expect(screen.getByRole('link', { name: '¿No tienes cuenta? Crear cuenta' })).toHaveAttribute(
      'href',
      '/signup'
    );
    unmount();
    render(<LoginForm locale="en" />);
    expect(screen.getByRole('link', { name: "Don't have an account? Create one" })).toHaveAttribute(
      'href',
      '/signup?lang=en'
    );
  });
});
