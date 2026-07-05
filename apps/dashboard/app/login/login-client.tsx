'use client';

import { useState } from 'react';
import { MESSAGES, type Locale } from '../messages';

/**
 * Formulario de login (F3-09b). Envía credenciales al route handler `/api/session`
 * (server-side), que las proxya a la API y, si hay sesión, fija la cookie httpOnly
 * `fluvia_session`. El navegador nunca sostiene el token; en éxito redirige a `/`.
 * MFA queda fuera de alcance: si la cuenta lo exige, se avisa (no se simula).
 */

type Phase = 'idle' | 'submitting' | 'error' | 'mfa';

export function LoginForm({ locale }: { locale: Locale }) {
  const t = MESSAGES[locale];
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPhase('submitting');
    try {
      const res = await fetch('/api/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (res.status === 200) {
        window.location.assign('/');
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { reason?: string };
      setPhase(body.reason === 'mfa' ? 'mfa' : 'error');
    } catch {
      setPhase('error');
    }
  }

  return (
    <main className="auth" aria-labelledby="login-title">
      <h1 id="login-title">{t.loginTitle}</h1>
      <form onSubmit={submit}>
        <label htmlFor="email">{t.emailLabel}</label>
        <input
          id="email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />

        <label htmlFor="password">{t.passwordLabel}</label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        {phase === 'error' && (
          <p className="error" role="alert">
            {t.loginError}
          </p>
        )}
        {phase === 'mfa' && (
          <p className="error" role="alert">
            {t.mfaUnsupported}
          </p>
        )}

        <button type="submit" className="primary" disabled={phase === 'submitting'}>
          {phase === 'submitting' ? t.signingIn : t.signIn}
        </button>
      </form>
      <p className="notice">{t.sandboxNotice}</p>
    </main>
  );
}
