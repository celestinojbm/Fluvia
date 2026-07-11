import { MESSAGES, type Locale } from '../messages';
import type { WebhookAttempt, WebhookEvent, WebhookEventDetail } from './api';
import { ResendButton } from './resend-button';

/**
 * Superficie de desarrollador (F6.5B) — eventos de webhook, SOLO LECTURA por
 * sesión (`payments:read`) más el reenvío existente (`webhooks:manage`, F3-09b).
 * Presentación pura (server component). Los serializers del API jamás exponen
 * secretos: el `payload` es el evento de negocio y `last_error`/`error` son
 * mensajes saneados — nunca firmas ni credenciales.
 */

function shortId(v: string | null): string {
  if (!v) return '—';
  return v.length > 12 ? `${v.slice(0, 8)}…${v.slice(-4)}` : v;
}
function when(v: string | null): string {
  return v ? v.replace('T', ' ').slice(0, 19) : '—';
}

export function WebhookEventsList({
  events,
  orgId,
  locale,
  signOutHref,
  canResend = false,
}: {
  events: WebhookEvent[];
  orgId: string;
  locale: Locale;
  signOutHref: string;
  /** El operador puede reenviar eventos `dead` (rol con webhooks:manage). */
  canResend?: boolean;
}) {
  const t = MESSAGES[locale];
  return (
    <main className="dash" aria-labelledby="whe-title">
      <header className="dash-head">
        <div>
          <h1 id="whe-title">{t.webhookEventsTitle}</h1>
          <p className="org">
            <a href={`/o/${orgId}`}>{t.backToDashboard}</a>
          </p>
        </div>
        <a className="signout" href={signOutHref}>
          {t.signOut}
        </a>
      </header>

      <section className="card">
        {events.length === 0 ? (
          <p className="empty">{t.webhookEventsEmpty}</p>
        ) : (
          <div className="table-wrap">
            <table>
              <caption className="sr-only">{t.webhookEventsTitle}</caption>
              <thead>
                <tr>
                  <th scope="col">{t.colEvent}</th>
                  <th scope="col">{t.fldTopic}</th>
                  <th scope="col">{t.colStatus}</th>
                  <th scope="col">{t.colAttempts}</th>
                  <th scope="col">{t.colCreated}</th>
                  {canResend && <th scope="col">{t.colAction}</th>}
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id}>
                    <td>
                      <a href={`/o/${orgId}/webhook-events/${e.id}`}>
                        <code>{shortId(e.id)}</code>
                      </a>
                    </td>
                    <td>{e.topic}</td>
                    <td>
                      <span className={`badge badge-${e.status}`}>{e.status}</span>
                    </td>
                    <td>{e.attempts}</td>
                    <td>{when(e.created_at)}</td>
                    {canResend && (
                      <td>
                        {e.status === 'dead' ? (
                          <ResendButton orgId={orgId} eventId={e.id} locale={locale} />
                        ) : (
                          <span>—</span>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <p className="notice">{t.sandboxNotice}</p>
    </main>
  );
}

export function WebhookEventDetailView({
  event,
  orgId,
  locale,
  signOutHref,
  canResend = false,
}: {
  event: WebhookEventDetail;
  orgId: string;
  locale: Locale;
  signOutHref: string;
  canResend?: boolean;
}) {
  const t = MESSAGES[locale];
  const rows: Array<{ label: string; value: string }> = [
    { label: t.colEvent, value: event.id },
    { label: t.colEndpoint, value: event.endpoint_id },
    { label: t.fldTopic, value: event.topic },
    { label: t.colAttempts, value: String(event.attempts) },
    { label: t.fldNextAttempt, value: when(event.next_attempt_at) },
    { label: t.fldDeliveredAt, value: when(event.delivered_at) },
    { label: t.fldResentFrom, value: shortId(event.resent_from_event_id) },
    { label: t.fldLastError, value: event.last_error ?? '—' },
    { label: t.colCreated, value: when(event.created_at) },
  ];
  return (
    <main className="dash" aria-labelledby="whe-detail-title">
      <header className="dash-head">
        <div>
          <h1 id="whe-detail-title">{t.webhookEventDetailTitle}</h1>
          <p className="org">
            <a href={`/o/${orgId}/webhook-events`}>{t.backToDashboard}</a> · {event.topic} ·{' '}
            <span className={`badge badge-${event.status}`}>{event.status}</span>
          </p>
        </div>
        <a className="signout" href={signOutHref}>
          {t.signOut}
        </a>
      </header>

      <section className="card">
        <div className="table-wrap">
          <table>
            <caption className="sr-only">{t.webhookEventDetailTitle}</caption>
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
        {canResend && event.status === 'dead' && (
          <p className="action-inline">
            <ResendButton orgId={orgId} eventId={event.id} locale={locale} />
          </p>
        )}
      </section>

      <section className="card" aria-labelledby="whe-payload-title">
        <h2 id="whe-payload-title">{t.payloadTitle}</h2>
        <pre className="payload">{JSON.stringify(event.payload, null, 2)}</pre>
      </section>

      <section className="card" aria-labelledby="whe-attempts-title">
        <h2 id="whe-attempts-title">
          {t.attemptsTitle} <span className="count">({event.attempts_history.length})</span>
        </h2>
        {event.attempts_history.length === 0 ? (
          <p className="empty">{t.attemptsEmpty}</p>
        ) : (
          <div className="table-wrap">
            <table>
              <caption className="sr-only">{t.attemptsTitle}</caption>
              <thead>
                <tr>
                  <th scope="col">{t.colAttempt}</th>
                  <th scope="col">{t.colStatusCode}</th>
                  <th scope="col">{t.colLatency}</th>
                  <th scope="col">{t.colResolvedIp}</th>
                  <th scope="col">{t.colError}</th>
                  <th scope="col">{t.colCreated}</th>
                </tr>
              </thead>
              <tbody>
                {event.attempts_history.map((a: WebhookAttempt) => (
                  <tr key={a.attempt_number}>
                    <td>{a.attempt_number}</td>
                    <td>{a.status_code ?? '—'}</td>
                    <td>{a.latency_ms ?? '—'}</td>
                    <td>
                      <code>{a.resolved_ip ?? '—'}</code>
                    </td>
                    <td>{a.error ?? '—'}</td>
                    <td>{when(a.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <p className="notice">{t.sandboxNotice}</p>
    </main>
  );
}
