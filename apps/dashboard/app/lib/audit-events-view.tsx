import { MESSAGES, type Locale } from '../messages';
import type { AuditEvent } from './api';

/**
 * Vista «ver eventos» del panel admin mínimo (F4-04b): la auditoría append-only
 * de acciones sensibles (F1-05), de solo lectura. Presentación pura (server
 * component). Paginación hacia atrás por cursor (`?before=<id>`), sin JS.
 */

function shortId(v: string | null): string {
  if (!v) return '—';
  return v.length > 12 ? `${v.slice(0, 8)}…${v.slice(-4)}` : v;
}
function when(v: string): string {
  return v ? v.replace('T', ' ').slice(0, 19) : '—';
}

function riskLabel(risk: string, t: (typeof MESSAGES)[Locale]): string {
  return { low: t.sevLow, medium: t.sevMedium, high: t.sevHigh }[risk] ?? risk;
}

export function AuditEventsList({
  events,
  nextBefore,
  orgId,
  locale,
  signOutHref,
}: {
  events: AuditEvent[];
  nextBefore: string | null;
  orgId: string;
  locale: Locale;
  signOutHref: string;
}) {
  const t = MESSAGES[locale];
  const langParam = locale === 'en' ? 'lang=en' : '';
  const olderHref = nextBefore
    ? `/o/${orgId}/events?${[langParam, `before=${encodeURIComponent(nextBefore)}`]
        .filter(Boolean)
        .join('&')}`
    : null;

  return (
    <main className="dash" aria-labelledby="events-title">
      <header className="dash-head">
        <div>
          <h1 id="events-title">{t.eventsTitle}</h1>
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
          <p className="empty">{t.eventsEmpty}</p>
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <caption className="sr-only">{t.eventsTitle}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t.colWhen}</th>
                    <th scope="col">{t.colActor}</th>
                    <th scope="col">{t.colAction}</th>
                    <th scope="col">{t.colResource}</th>
                    <th scope="col">{t.colResult}</th>
                    <th scope="col">{t.colRisk}</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((e) => (
                    <tr key={e.id}>
                      <td>{when(e.created_at)}</td>
                      <td>
                        {e.actor_type} · <code>{shortId(e.actor_id)}</code>
                      </td>
                      <td>
                        <code>{e.action}</code>
                      </td>
                      <td>
                        {e.resource_type ?? '—'}
                        {e.resource_id ? (
                          <>
                            {' '}
                            <code>{shortId(e.resource_id)}</code>
                          </>
                        ) : null}
                      </td>
                      <td>
                        <span className={`badge result-${e.result}`}>
                          {e.result === 'success' ? t.resultSuccess : t.resultFailure}
                        </span>
                      </td>
                      <td>
                        <span className={`badge risk-${e.risk_level}`}>
                          {riskLabel(e.risk_level, t)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {olderHref && (
              <p className="pager">
                <a className="filter" href={olderHref}>
                  {t.olderEvents}
                </a>
              </p>
            )}
          </>
        )}
      </section>
      <p className="notice">{t.sandboxNotice}</p>
    </main>
  );
}
