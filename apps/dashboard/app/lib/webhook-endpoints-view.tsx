'use client';

import { useState } from 'react';
import { MESSAGES, type Locale } from '../messages';
import type { WebhookEndpoint } from './api';
import { SecretRevealOnce } from './secret-reveal-once';
import { StepUpModal } from './step-up-modal';

/**
 * F6.5B1 — vistas de webhook endpoints. Lista/detalle son SOLO LECTURA (el
 * serializer del API nunca trae el secreto). Crear/rotar/desactivar son acciones
 * de CLIENTE que POSTean a route handlers de sesión (`webhooks:manage`); el
 * secreto `whsec_` de create/rotate se muestra UNA vez con `SecretRevealOnce`
 * (estado efímero, sin storage, limpieza al cerrar). Solo se renderiza a roles
 * con `webhooks:manage` (hint UX; el API es la fuente de verdad).
 *
 * RA-F65B-001: las mutaciones exigen step-up fresco en el API. Si responde
 * 403 `mfa_step_up_required` se abre `StepUpModal` (password, patrón F6.5B2) y
 * la acción se REINTENTA una sola vez. Sin bucles; cuentas con MFA reciben el
 * mensaje honesto (el password no sustituye al TOTP; sin bypass).
 */

function shortId(v: string): string {
  return v.length > 12 ? `${v.slice(0, 8)}…${v.slice(-4)}` : v;
}
function when(v: string | null): string {
  return v ? v.replace('T', ' ').slice(0, 16) : '—';
}

interface ActionResult {
  ok: boolean;
  status: number;
  code?: string;
  body?: unknown;
}

async function postAction(url: string, body?: unknown): Promise<ActionResult> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      ...(body !== undefined
        ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
        : {}),
    });
    let parsed: unknown;
    let code: string | undefined;
    try {
      parsed = await res.clone().json();
      code = (parsed as { error?: { code?: string } }).error?.code;
    } catch {
      /* sin cuerpo JSON */
    }
    return { ok: res.ok, status: res.status, code, body: parsed };
  } catch {
    return { ok: false, status: 0, body: undefined };
  }
}

const needsStepUp = (r: ActionResult) => r.status === 403 && r.code === 'mfa_step_up_required';

export function WebhookEndpointsList({
  endpoints,
  orgId,
  locale,
  signOutHref,
  canManage = false,
}: {
  endpoints: WebhookEndpoint[];
  orgId: string;
  locale: Locale;
  signOutHref: string;
  canManage?: boolean;
}) {
  const t = MESSAGES[locale];
  return (
    <main className="dash" aria-labelledby="whep-title">
      <header className="dash-head">
        <div>
          <h1 id="whep-title">{t.webhookEndpointsTitle}</h1>
          <p className="org">
            <a href={`/o/${orgId}`}>{t.backToDashboard}</a>
          </p>
        </div>
        <a className="signout" href={signOutHref}>
          {t.signOut}
        </a>
      </header>

      <section className="card">
        {endpoints.length === 0 ? (
          <p className="empty">{t.webhookEndpointsEmpty}</p>
        ) : (
          <div className="table-wrap">
            <table>
              <caption className="sr-only">{t.webhookEndpointsTitle}</caption>
              <thead>
                <tr>
                  <th scope="col">{t.colId}</th>
                  <th scope="col">{t.colUrl}</th>
                  <th scope="col">{t.colStatus}</th>
                  <th scope="col">{t.colEvents}</th>
                  <th scope="col">{t.colCreated}</th>
                </tr>
              </thead>
              <tbody>
                {endpoints.map((e) => (
                  <tr key={e.id}>
                    <td>
                      <a href={`/o/${orgId}/webhook-endpoints/${e.id}`}>
                        <code>{shortId(e.id)}</code>
                      </a>
                    </td>
                    <td>
                      <code>{e.url}</code>
                    </td>
                    <td>
                      <span className={`badge badge-${e.status}`}>{e.status}</span>
                    </td>
                    <td>{e.events.length === 0 ? t.allEvents : e.events.length}</td>
                    <td>{when(e.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {canManage ? (
          <CreateEndpointForm orgId={orgId} locale={locale} />
        ) : (
          <p className="hint">{t.endpointManageNoRole}</p>
        )}
      </section>
      <p className="notice">{t.sandboxNotice}</p>
    </main>
  );
}

function CreateEndpointForm({ orgId, locale }: { orgId: string; locale: Locale }) {
  const t = MESSAGES[locale];
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState('');
  const [phase, setPhase] = useState<'idle' | 'busy' | 'stepup' | 'error'>('idle');
  const [secret, setSecret] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function attempt(isRetryAfterStepUp: boolean) {
    setPhase('busy');
    setErrorMsg(null);
    const eventList = events
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const r = await postAction(`/api/orgs/${encodeURIComponent(orgId)}/webhook-endpoints`, {
      url: url.trim(),
      ...(eventList.length ? { events: eventList } : {}),
    });
    if (r.ok) {
      // El secreto vive SOLO aquí, en state efímero; se revela una vez.
      setSecret(String((r.body as { secret?: string })?.secret ?? ''));
      setPhase('idle');
      return;
    }
    if (needsStepUp(r) && !isRetryAfterStepUp) {
      setPhase('stepup'); // abrir modal; reintento UNA vez tras el step-up
      return;
    }
    // 403 tras step-up (p. ej. usuario MFA) o cualquier otro error: sin bucle.
    setErrorMsg(needsStepUp(r) ? t.stepUpMfaRequired : t.actionError);
    setPhase('error');
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;
    attempt(false);
  }

  if (secret) {
    return (
      <div className="action-form">
        <p className="resent">{t.endpointCreated}</p>
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
      <form className="action-form" onSubmit={submit}>
        <fieldset>
          <legend>{t.createEndpointTitle}</legend>
          <label htmlFor="ep-url">{t.endpointUrlLabel}</label>
          <input
            id="ep-url"
            name="url"
            type="url"
            required
            value={url}
            onChange={(ev) => setUrl(ev.target.value)}
            aria-describedby="ep-url-hint"
          />
          <p id="ep-url-hint" className="hint">
            {t.endpointUrlHint}
          </p>
          <label htmlFor="ep-events">{t.endpointEventsLabel}</label>
          <input
            id="ep-events"
            name="events"
            value={events}
            onChange={(ev) => setEvents(ev.target.value)}
            aria-describedby="ep-events-hint"
          />
          <p id="ep-events-hint" className="hint">
            {t.endpointEventsHint}
          </p>
          <button type="submit" className="btn" disabled={phase === 'busy' || phase === 'stepup'}>
            {phase === 'busy' ? t.creating : t.createEndpointAction}
          </button>
          {phase === 'error' && errorMsg && (
            <span className="error" role="alert">
              {errorMsg}
            </span>
          )}
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

export function WebhookEndpointDetailView({
  endpoint,
  orgId,
  locale,
  signOutHref,
  canManage = false,
}: {
  endpoint: WebhookEndpoint;
  orgId: string;
  locale: Locale;
  signOutHref: string;
  canManage?: boolean;
}) {
  const t = MESSAGES[locale];
  const rows: Array<{ label: string; value: string }> = [
    { label: t.colId, value: endpoint.id },
    { label: t.colUrl, value: endpoint.url },
    { label: t.fldDescription2, value: endpoint.description ?? '—' },
    {
      label: t.colEvents,
      value: endpoint.events.length === 0 ? t.allEvents : endpoint.events.join(', '),
    },
    { label: t.colCreated, value: when(endpoint.created_at) },
    { label: t.fldDisabledAt, value: when(endpoint.disabled_at) },
  ];
  return (
    <main className="dash" aria-labelledby="whep-detail-title">
      <header className="dash-head">
        <div>
          <h1 id="whep-detail-title">{t.webhookEndpointDetailTitle}</h1>
          <p className="org">
            <a href={`/o/${orgId}/webhook-endpoints`}>{t.backToDashboard}</a> ·{' '}
            <span className={`badge badge-${endpoint.status}`}>{endpoint.status}</span> ·{' '}
            <a href={`/o/${orgId}/webhook-events`}>{t.viewRelatedEvents}</a>
          </p>
        </div>
        <a className="signout" href={signOutHref}>
          {t.signOut}
        </a>
      </header>

      <section className="card">
        <div className="table-wrap">
          <table>
            <caption className="sr-only">{t.webhookEndpointDetailTitle}</caption>
            <tbody>
              {rows.map((r) => (
                <tr key={r.label}>
                  <th scope="row">{r.label}</th>
                  <td>
                    <code>{r.value}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {canManage && endpoint.status === 'active' && (
          <EndpointActions orgId={orgId} endpointId={endpoint.id} locale={locale} />
        )}
      </section>
      <p className="notice">{t.sandboxNotice}</p>
    </main>
  );
}

function EndpointActions({
  orgId,
  endpointId,
  locale,
}: {
  orgId: string;
  endpointId: string;
  locale: Locale;
}) {
  const t = MESSAGES[locale];
  const [phase, setPhase] = useState<'idle' | 'rotating' | 'disabling' | 'stepup' | 'error'>(
    'idle'
  );
  // Qué acción reintentar UNA vez tras el step-up (RA-F65B-001).
  const [stepUpFor, setStepUpFor] = useState<'rotate' | 'disable' | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function attemptRotate(isRetryAfterStepUp: boolean) {
    setPhase('rotating');
    setErrorMsg(null);
    const r = await postAction(
      `/api/orgs/${encodeURIComponent(orgId)}/webhook-endpoints/${encodeURIComponent(endpointId)}/rotate`
    );
    if (r.ok) {
      setSecret(String((r.body as { secret?: string })?.secret ?? ''));
      setPhase('idle');
      return;
    }
    if (needsStepUp(r) && !isRetryAfterStepUp) {
      setStepUpFor('rotate');
      setPhase('stepup');
      return;
    }
    setErrorMsg(needsStepUp(r) ? t.stepUpMfaRequired : t.actionError);
    setPhase('error');
  }

  async function attemptDisable(isRetryAfterStepUp: boolean) {
    setPhase('disabling');
    setErrorMsg(null);
    const r = await postAction(
      `/api/orgs/${encodeURIComponent(orgId)}/webhook-endpoints/${encodeURIComponent(endpointId)}/disable`
    );
    if (r.ok) {
      setDisabled(true);
      setPhase('idle');
      setTimeout(() => window.location.reload(), 600);
      return;
    }
    if (needsStepUp(r) && !isRetryAfterStepUp) {
      setStepUpFor('disable');
      setPhase('stepup');
      return;
    }
    setErrorMsg(needsStepUp(r) ? t.stepUpMfaRequired : t.actionError);
    setPhase('error');
  }

  function rotate() {
    if (!window.confirm(t.rotateConfirm)) return;
    attemptRotate(false);
  }

  function disable() {
    if (!window.confirm(t.disableConfirm)) return;
    attemptDisable(false);
  }

  if (secret) {
    return (
      <SecretRevealOnce
        secret={secret}
        locale={locale}
        onDismiss={() => {
          setSecret(null);
          window.location.reload();
        }}
      />
    );
  }
  if (disabled) return <p className="resent">{t.disabledOk}</p>;

  return (
    <div className="action-inline">
      <button type="button" className="btn" onClick={rotate} disabled={phase !== 'idle'}>
        {phase === 'rotating' ? t.creating : t.rotateAction}
      </button>
      <button
        type="button"
        className="btn btn-danger"
        onClick={disable}
        disabled={phase !== 'idle'}
      >
        {phase === 'disabling' ? t.creating : t.disableAction}
      </button>
      {phase === 'error' && errorMsg && (
        <span className="error" role="alert">
          {errorMsg}
        </span>
      )}
      {phase === 'stepup' && stepUpFor && (
        <StepUpModal
          locale={locale}
          onSuccess={() => {
            const action = stepUpFor;
            setStepUpFor(null);
            if (action === 'rotate') attemptRotate(true);
            else attemptDisable(true);
          }}
          onCancel={() => {
            setStepUpFor(null);
            setPhase('idle');
          }}
        />
      )}
    </div>
  );
}
