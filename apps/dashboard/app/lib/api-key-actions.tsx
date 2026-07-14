'use client';

import { useState } from 'react';
import { API_KEY_SCOPES } from './api';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from './csrf-header';
import { MESSAGES, type Locale } from '../messages';
import { SecretRevealOnce } from './secret-reveal-once';
import { StepUpModal } from './step-up-modal';

/**
 * F6.5B2 — acciones de ESCRITURA sobre API keys por sesión: crear y revocar.
 * SOLO consume endpoints existentes (`POST .../api-keys`, `.../:id/revoke`) vía
 * route handlers de sesión. Ambos exigen `keys:manage` + step-up MFA en el API;
 * si el API responde 403 `mfa_step_up_required`, se abre `StepUpModal` (password)
 * y se REINTENTA la acción UNA sola vez tras el step-up. Sin bucles. El secreto
 * de la key creada se revela una sola vez con `SecretRevealOnce` (estado
 * efímero, sin storage/URL/logs). Estos controles solo se muestran a roles con
 * `keys:manage` (hint UX; el API es la fuente de verdad).
 */

interface ActionResult {
  ok: boolean;
  status: number;
  code?: string;
  body?: unknown;
}

async function post(url: string, body?: unknown): Promise<ActionResult> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      // RA-F65B-EXT-002: header anti-CSRF exigido por los route handlers mutantes.
      headers: {
        [CSRF_HEADER]: CSRF_HEADER_VALUE,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let parsed: unknown;
    let code: string | undefined;
    try {
      parsed = await res.clone().json();
      code = (parsed as { error?: { code?: string } }).error?.code;
    } catch {
      /* 204 o sin cuerpo JSON */
    }
    return { ok: res.ok, status: res.status, code, body: parsed };
  } catch {
    return { ok: false, status: 0 };
  }
}

const needsStepUp = (r: ActionResult) => r.status === 403 && r.code === 'mfa_step_up_required';

export function CreateApiKeyForm({ orgId, locale }: { orgId: string; locale: Locale }) {
  const t = MESSAGES[locale];
  const [label, setLabel] = useState('');
  const [scopes, setScopes] = useState<string[]>(['read']);
  const [phase, setPhase] = useState<'idle' | 'busy' | 'stepup' | 'error'>('idle');
  const [secret, setSecret] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const valid = label.trim().length > 0 && scopes.length > 0;

  function toggleScope(scope: string) {
    setScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]
    );
  }

  async function attempt(isRetryAfterStepUp: boolean) {
    setPhase('busy');
    setErrorMsg(null);
    const r = await post(`/api/orgs/${encodeURIComponent(orgId)}/api-keys`, {
      label: label.trim(),
      scopes,
      environment: 'test',
    });
    if (r.ok) {
      setSecret(String((r.body as { secret?: string })?.secret ?? ''));
      setPhase('idle');
      return;
    }
    if (needsStepUp(r) && !isRetryAfterStepUp) {
      setPhase('stepup'); // abrir modal; reintento UNA vez tras el step-up
      return;
    }
    // 403 tras step-up (p. ej. usuario MFA) o cualquier otro error: sin bucle.
    setErrorMsg(
      needsStepUp(r) ? t.stepUpMfaRequired : `${t.actionError}${r.code ? ` (${r.code})` : ''}`
    );
    setPhase('error');
  }

  if (secret) {
    return (
      <div className="action-form">
        <p className="resent">{t.apiKeyCreated}</p>
        <SecretRevealOnce
          secret={secret}
          locale={locale}
          onDismiss={() => {
            setSecret(null); // limpia el secreto del estado
            window.location.reload();
          }}
        />
      </div>
    );
  }

  return (
    <>
      <form
        className="action-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) attempt(false);
        }}
      >
        <fieldset>
          <legend>{t.createApiKeyTitle}</legend>
          <label htmlFor="key-label">{t.apiKeyLabelField}</label>
          <input
            id="key-label"
            name="label"
            required
            maxLength={80}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <fieldset className="scopes">
            <legend>{t.apiKeyScopesField}</legend>
            {API_KEY_SCOPES.map((scope) => (
              <label key={scope} className="scope-option">
                <input
                  type="checkbox"
                  checked={scopes.includes(scope)}
                  onChange={() => toggleScope(scope)}
                />{' '}
                <code>{scope}</code>
              </label>
            ))}
            <p className="hint">{t.apiKeyScopesHint}</p>
          </fieldset>
          <p className="hint">{t.apiKeyEnvNote}</p>
          <button type="submit" className="btn" disabled={!valid || phase === 'busy'}>
            {phase === 'busy' ? t.creating : t.createApiKeyAction}
          </button>
          {phase === 'error' && errorMsg && (
            <p className="error" role="alert">
              {errorMsg}
            </p>
          )}
          {!valid && scopes.length === 0 && <p className="hint">{t.selectAtLeastOneScope}</p>}
        </fieldset>
      </form>
      {phase === 'stepup' && (
        <StepUpModal
          locale={locale}
          onSuccess={() => attempt(true)}
          onCancel={() => setPhase('idle')}
        />
      )}
    </>
  );
}

export function RevokeKeyButton({
  orgId,
  keyId,
  locale,
}: {
  orgId: string;
  keyId: string;
  locale: Locale;
}) {
  const t = MESSAGES[locale];
  const [phase, setPhase] = useState<'idle' | 'busy' | 'stepup' | 'done' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function attempt(isRetryAfterStepUp: boolean) {
    setPhase('busy');
    setErrorMsg(null);
    const r = await post(
      `/api/orgs/${encodeURIComponent(orgId)}/api-keys/${encodeURIComponent(keyId)}/revoke`
    );
    if (r.ok) {
      setPhase('done');
      setTimeout(() => window.location.reload(), 600);
      return;
    }
    if (needsStepUp(r) && !isRetryAfterStepUp) {
      setPhase('stepup');
      return;
    }
    setErrorMsg(
      needsStepUp(r) ? t.stepUpMfaRequired : `${t.actionError}${r.code ? ` (${r.code})` : ''}`
    );
    setPhase('error');
  }

  function start() {
    if (!window.confirm(t.revokeConfirm)) return;
    attempt(false);
  }

  if (phase === 'done') return <span className="resent">{t.keyRevokedOk}</span>;

  return (
    <span className="resend-cell">
      <button
        type="button"
        className="resend btn-danger"
        onClick={start}
        disabled={phase === 'busy' || phase === 'stepup'}
      >
        {phase === 'busy' ? t.rejecting : t.revokeAction}
      </button>
      {phase === 'error' && errorMsg && (
        <span className="error" role="alert">
          {errorMsg}
        </span>
      )}
      {phase === 'stepup' && (
        <StepUpModal
          locale={locale}
          onSuccess={() => attempt(true)}
          onCancel={() => setPhase('idle')}
        />
      )}
    </span>
  );
}
