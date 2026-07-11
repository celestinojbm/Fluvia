import { MESSAGES, type Locale } from '../messages';
import type { CheckoutSession } from './api';
import { CopyUrlButton } from './copy-button';

/**
 * Vistas de sesiones de checkout (F6.5A) — SOLO LECTURA por sesión
 * (`payments:read`). La única interacción es copiar la URL sandbox de pago al
 * portapapeles (no mutante). La sesión enlaza a su payment intent.
 */

function shortId(v: string): string {
  return v.length > 12 ? `${v.slice(0, 8)}…${v.slice(-4)}` : v;
}
function when(v: string | null): string {
  return v ? v.replace('T', ' ').slice(0, 16) : '—';
}

export function CheckoutSessionsList({
  sessions,
  orgId,
  locale,
  signOutHref,
}: {
  sessions: CheckoutSession[];
  orgId: string;
  locale: Locale;
  signOutHref: string;
}) {
  const t = MESSAGES[locale];
  return (
    <main className="dash" aria-labelledby="sessions-title">
      <header className="dash-head">
        <div>
          <h1 id="sessions-title">{t.sessionsTitle}</h1>
          <p className="org">
            <a href={`/o/${orgId}`}>{t.backToDashboard}</a>
          </p>
        </div>
        <a className="signout" href={signOutHref}>
          {t.signOut}
        </a>
      </header>

      <section className="card">
        {sessions.length === 0 ? (
          <p className="empty">{t.sessionsEmpty}</p>
        ) : (
          <div className="table-wrap">
            <table>
              <caption className="sr-only">{t.sessionsTitle}</caption>
              <thead>
                <tr>
                  <th scope="col">{t.colId}</th>
                  <th scope="col">{t.colPayment}</th>
                  <th scope="col">{t.colStatus}</th>
                  <th scope="col">{t.colCreated}</th>
                  <th scope="col">{t.fldExpires}</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <a href={`/o/${orgId}/checkout-sessions/${s.id}`}>
                        <code>{shortId(s.id)}</code>
                      </a>
                    </td>
                    <td>
                      <a href={`/o/${orgId}/payments/${s.payment_intent_id}`}>
                        <code>{shortId(s.payment_intent_id)}</code>
                      </a>
                    </td>
                    <td>
                      <span className={`badge badge-${s.status}`}>{s.status}</span>
                    </td>
                    <td>{when(s.created_at)}</td>
                    <td>{when(s.expires_at)}</td>
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

export function CheckoutSessionDetail({
  session,
  orgId,
  locale,
  signOutHref,
}: {
  session: CheckoutSession;
  orgId: string;
  locale: Locale;
  signOutHref: string;
}) {
  const t = MESSAGES[locale];
  const rows: Array<{ label: string; value: string }> = [
    { label: t.colId, value: session.id },
    { label: t.fldCustomer, value: session.customer_id ?? '—' },
    { label: t.colCreated, value: when(session.created_at) },
    { label: t.fldExpires, value: when(session.expires_at) },
    { label: t.fldCompletedAt, value: when(session.completed_at) },
  ];
  return (
    <main className="dash" aria-labelledby="session-detail-title">
      <header className="dash-head">
        <div>
          <h1 id="session-detail-title">{t.sessionDetailTitle}</h1>
          <p className="org">
            <a href={`/o/${orgId}/checkout-sessions`}>{t.backToDashboard}</a> ·{' '}
            <span className={`badge badge-${session.status}`}>{session.status}</span>
          </p>
        </div>
        <a className="signout" href={signOutHref}>
          {t.signOut}
        </a>
      </header>

      <section className="card">
        <div className="table-wrap">
          <table>
            <caption className="sr-only">{t.sessionDetailTitle}</caption>
            <tbody>
              {rows.map((r) => (
                <tr key={r.label}>
                  <th scope="row">{r.label}</th>
                  <td>
                    <code>{r.value}</code>
                  </td>
                </tr>
              ))}
              <tr>
                <th scope="row">{t.colPayment}</th>
                <td>
                  <a href={`/o/${orgId}/payments/${session.payment_intent_id}`}>
                    <code>{session.payment_intent_id}</code>
                  </a>
                </td>
              </tr>
              <tr>
                <th scope="row">{t.fldCheckoutUrl}</th>
                <td className="action-inline">
                  <code>{session.url}</code>
                  <CopyUrlButton url={session.url} locale={locale} />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
      <p className="notice">{t.sandboxNotice}</p>
    </main>
  );
}
