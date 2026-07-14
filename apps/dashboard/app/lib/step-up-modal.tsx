'use client';

import { useEffect, useState } from 'react';
import { MESSAGES, type Locale } from '../messages';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from './csrf-header';

/**
 * F6.5B2 — modal de step-up por password. Pide la contraseña y la reenvía UNA
 * vez a `/api/step-up/password` (proxy al endpoint de auth existente); el
 * password vive SOLO en estado efímero de React, se limpia al cerrar, al éxito
 * y al desmontar; nunca en storage/URL/logs/analytics ni server-rendered.
 *
 * Resultados: `ok` (step-up hecho — el servidor marcó password_verified_at) o
 * `mfa` (la cuenta tiene MFA: el password NO basta — el backend lo rechaza con
 * 403; se muestra el mensaje honesto B2-MFA, sin bypass). El reintento de la
 * ACCIÓN original lo decide el llamador (una sola vez).
 */
export type StepUpResult = 'ok' | 'mfa';

export function StepUpModal({
  locale,
  onSuccess,
  onCancel,
}: {
  locale: Locale;
  onSuccess: () => void;
  onCancel: () => void;
}) {
  const t = MESSAGES[locale];
  const [password, setPassword] = useState('');
  const [phase, setPhase] = useState<'idle' | 'busy'>('idle');
  const [error, setError] = useState<string | null>(null);

  // El password JAMÁS se persiste; al desmontar se limpia el estado transitorio.
  useEffect(() => {
    return () => {
      setPassword('');
      setError(null);
    };
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!password) return;
    setPhase('busy');
    setError(null);
    try {
      const res = await fetch('/api/step-up/password', {
        method: 'POST',
        // RA-F65B-EXT-002: header anti-CSRF exigido por el route handler mutante.
        headers: { 'content-type': 'application/json', [CSRF_HEADER]: CSRF_HEADER_VALUE },
        body: JSON.stringify({ password }),
      });
      // No reintentar en bucle: un único intento por envío del usuario.
      if (res.ok) {
        setPassword(''); // limpia el password al éxito
        onSuccess();
        return;
      }
      let code: string | undefined;
      try {
        code = ((await res.json()) as { error?: { code?: string } }).error?.code;
      } catch {
        /* sin cuerpo */
      }
      setPassword(''); // limpia el password también en el fallo
      if (res.status === 403 && code === 'mfa_step_up_required') setError(t.stepUpMfaRequired);
      else if (code === 'account_locked' || code === 'rate_limited') setError(t.stepUpLocked);
      else setError(t.stepUpWrongPassword);
      setPhase('idle');
    } catch {
      setPassword('');
      setError(t.stepUpWrongPassword);
      setPhase('idle');
    }
  }

  function cancel() {
    setPassword(''); // limpia el password al cerrar
    onCancel();
  }

  return (
    <div className="stepup-backdrop" role="dialog" aria-modal="true" aria-labelledby="stepup-title">
      <div className="stepup-modal">
        <h2 id="stepup-title">{t.stepUpTitle}</h2>
        <p className="hint">{t.stepUpPrompt}</p>
        <form className="action-form" onSubmit={submit}>
          <label htmlFor="stepup-password">{t.stepUpPasswordLabel}</label>
          <input
            id="stepup-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <div className="action-inline">
            <button type="submit" className="btn" disabled={phase === 'busy'}>
              {phase === 'busy' ? t.stepUpVerifying : t.stepUpSubmit}
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={cancel}
              disabled={phase === 'busy'}
            >
              {t.stepUpCancel}
            </button>
          </div>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </form>
      </div>
    </div>
  );
}
