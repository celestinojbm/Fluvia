'use client';

import { useRef, useState } from 'react';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../lib/csrf-header';
import { MESSAGES, type Locale } from '../messages';

/**
 * Formulario de signup sandbox (F6.5C1/B6). Envía email+password al proxy
 * server-side `/api/signup` (guard CSRF + backend local/test); la confirmación
 * de password es SOLO ergonomía de UI (la validación normativa vive en
 * `RegisterSchema` del backend y esta UI no define reglas divergentes).
 * Al éxito redirige a /login SIN auto-login: no se crea sesión, no hay cookie,
 * ningún token llega al navegador. La verificación de email es SIMULADA
 * (sandbox): no se envía correo real.
 */

type Phase = 'idle' | 'submitting' | 'success';
type SignupError = null | 'mismatch' | 'email_taken' | 'invalid' | 'generic';

export function SignupForm({
  locale,
  navigate,
}: {
  locale: Locale;
  /** Inyectable para tests; default: navegación real del navegador. */
  navigate?: (url: string) => void;
}) {
  const t = MESSAGES[locale];
  const go = navigate ?? ((url: string) => window.location.assign(url));
  const loginHref = locale === 'en' ? '/login?lang=en' : '/login';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<SignupError>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);

  function showError(kind: Exclude<SignupError, null>) {
    setError(kind);
    setPhase('idle');
    // Foco razonable tras el error: el lector de pantalla anuncia el alert y
    // el foco queda sobre él (tabIndex=-1) para retomar el formulario.
    requestAnimationFrame(() => errorRef.current?.focus());
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (phase === 'submitting' || phase === 'success') return; // anti doble-submit
    setError(null);
    if (password !== confirm) {
      showError('mismatch');
      return;
    }
    setPhase('submitting');
    try {
      const res = await fetch('/api/signup', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [CSRF_HEADER]: CSRF_HEADER_VALUE,
        },
        body: JSON.stringify({ email, password }),
      });
      if (res.status === 201) {
        setPhase('success');
        go(loginHref);
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: { code?: string } };
      if (body.error?.code === 'email_taken') showError('email_taken');
      else if (body.error?.code === 'validation_error') showError('invalid');
      else showError('generic');
    } catch {
      showError('generic');
    }
  }

  const errorText =
    error === 'mismatch'
      ? t.signupPasswordMismatch
      : error === 'email_taken'
        ? t.signupEmailTaken
        : error === 'invalid'
          ? t.signupInvalidInput
          : t.signupGenericError;

  return (
    <main className="auth" aria-labelledby="signup-title">
      <h1 id="signup-title">{t.signupTitle}</h1>
      <p className="notice">{t.signupSandboxVerification}</p>
      <form onSubmit={submit}>
        <label htmlFor="email">{t.emailLabel}</label>
        <input
          id="email"
          type="email"
          autoComplete="username"
          required
          maxLength={254}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />

        <label htmlFor="password">{t.passwordLabel}</label>
        <input
          id="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={10}
          maxLength={128}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        <label htmlFor="confirm-password">{t.confirmPasswordLabel}</label>
        <input
          id="confirm-password"
          type="password"
          autoComplete="new-password"
          required
          minLength={10}
          maxLength={128}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />

        {error !== null && (
          <p className="error" role="alert" tabIndex={-1} ref={errorRef}>
            {errorText}
          </p>
        )}
        {phase === 'success' && (
          <p className="notice" role="status">
            {t.signupSuccess}
          </p>
        )}

        <button
          type="submit"
          className="primary"
          disabled={phase === 'submitting' || phase === 'success'}
        >
          {phase === 'submitting' ? t.creatingAccount : t.createAccount}
        </button>
      </form>
      <p className="notice">{t.signupNoRealEmail}</p>
      <p className="notice">{t.sandboxNotice}</p>
      <p>
        <a href={loginHref}>{t.backToLogin}</a>
      </p>
    </main>
  );
}
