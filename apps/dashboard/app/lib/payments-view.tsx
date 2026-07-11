import { formatAmount, MESSAGES, type Locale } from '../messages';
import type { CheckoutSession, PaymentIntent, Refund, TimelineKind } from './api';
import { paymentTimeline } from './api';

/**
 * Vistas de pagos (F6.5A) — presentación pura (server components, renderizables
 * en jsdom). SOLO LECTURA: no hay acción mutante en esta superficie; el permiso
 * que la gobierna es `payments:read` (todo rol) y el API es la fuente de verdad.
 * La línea de tiempo se DERIVA de timestamps persistidos del intent y sus
 * recursos relacionados — no simula un event-log que el API no tiene.
 */

function shortId(v: string): string {
  return v.length > 12 ? `${v.slice(0, 8)}…${v.slice(-4)}` : v;
}
function when(v: string | null): string {
  return v ? v.replace('T', ' ').slice(0, 16) : '—';
}

export function PaymentsList({
  intents,
  orgId,
  locale,
  signOutHref,
}: {
  intents: PaymentIntent[];
  orgId: string;
  locale: Locale;
  signOutHref: string;
}) {
  const t = MESSAGES[locale];
  return (
    <main className="dash" aria-labelledby="payments-title">
      <header className="dash-head">
        <div>
          <h1 id="payments-title">{t.paymentsTitle}</h1>
          <p className="org">
            <a href={`/o/${orgId}`}>{t.backToDashboard}</a>
          </p>
        </div>
        <a className="signout" href={signOutHref}>
          {t.signOut}
        </a>
      </header>

      <section className="card">
        {intents.length === 0 ? (
          <p className="empty">{t.paymentsEmpty}</p>
        ) : (
          <div className="table-wrap">
            <table>
              <caption className="sr-only">{t.paymentsTitle}</caption>
              <thead>
                <tr>
                  <th scope="col">{t.colPayment}</th>
                  <th scope="col">{t.colMerchant}</th>
                  <th scope="col">{t.colAmount}</th>
                  <th scope="col">{t.colStatus}</th>
                  <th scope="col">{t.colCreated}</th>
                </tr>
              </thead>
              <tbody>
                {intents.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <a href={`/o/${orgId}/payments/${p.id}`}>
                        <code>{shortId(p.id)}</code>
                      </a>
                    </td>
                    <td>
                      <code>{shortId(p.merchant_id)}</code>
                    </td>
                    <td>{formatAmount(p.amount, p.currency, locale)}</td>
                    <td>
                      <span className={`badge badge-${p.status}`}>{p.status}</span>
                    </td>
                    <td>{when(p.created_at)}</td>
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

export function PaymentDetail({
  intent,
  refunds,
  sessions,
  orgId,
  locale,
  signOutHref,
}: {
  intent: PaymentIntent;
  /** Refunds YA filtrados por el API (`?payment_intent_id=`). */
  refunds: Refund[];
  /** Sesiones YA filtradas a este intent (`sessionsForIntent`). */
  sessions: CheckoutSession[];
  orgId: string;
  locale: Locale;
  signOutHref: string;
}) {
  const t = MESSAGES[locale];
  const tlLabel: Record<TimelineKind, string> = {
    payment_created: t.tlPaymentCreated,
    session_created: t.tlSessionCreated,
    session_completed: t.tlSessionCompleted,
    refund_created: t.tlRefundCreated,
  };
  const timeline = paymentTimeline(intent, refunds, sessions);
  const rows: Array<{ label: string; value: string }> = [
    { label: t.colPayment, value: intent.id },
    { label: t.colMerchant, value: intent.merchant_id },
    { label: t.colAmount, value: formatAmount(intent.amount, intent.currency, locale) },
    { label: t.fldCaptured, value: formatAmount(intent.amount_captured, intent.currency, locale) },
    { label: t.fldRefunded, value: formatAmount(intent.amount_refunded, intent.currency, locale) },
    { label: t.fldCaptureMethod, value: intent.capture_method },
    { label: t.fldFailureCode, value: intent.failure_code ?? '—' },
    { label: t.colCreated, value: when(intent.created_at) },
  ];
  return (
    <main className="dash" aria-labelledby="payment-detail-title">
      <header className="dash-head">
        <div>
          <h1 id="payment-detail-title">{t.paymentDetailTitle}</h1>
          <p className="org">
            <a href={`/o/${orgId}/payments`}>{t.backToDashboard}</a> ·{' '}
            {formatAmount(intent.amount, intent.currency, locale)} ·{' '}
            <span className={`badge badge-${intent.status}`}>{intent.status}</span>
          </p>
        </div>
        <a className="signout" href={signOutHref}>
          {t.signOut}
        </a>
      </header>

      <section className="card">
        <div className="table-wrap">
          <table>
            <caption className="sr-only">{t.paymentDetailTitle}</caption>
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
      </section>

      <section className="card" aria-labelledby="payment-timeline-title">
        <h2 id="payment-timeline-title">{t.timelineTitle}</h2>
        <ol className="timeline">
          {timeline.map((e, i) => (
            <li key={`${e.kind}-${e.refId}-${i}`}>
              <span className="tl-when">{when(e.at)}</span>
              <span className="tl-label">{tlLabel[e.kind]}</span>
              <code>{shortId(e.refId)}</code>
              <span className={`badge badge-${e.status}`}>{e.status}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="card" aria-labelledby="payment-refunds-title">
        <h2 id="payment-refunds-title">
          {t.relatedRefunds} <span className="count">({refunds.length})</span>
        </h2>
        {refunds.length === 0 ? (
          <p className="empty">{t.refundsEmpty}</p>
        ) : (
          <div className="table-wrap">
            <table>
              <caption className="sr-only">{t.relatedRefunds}</caption>
              <thead>
                <tr>
                  <th scope="col">{t.colId}</th>
                  <th scope="col">{t.colAmount}</th>
                  <th scope="col">{t.colStatus}</th>
                  <th scope="col">{t.colCreated}</th>
                </tr>
              </thead>
              <tbody>
                {refunds.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <a href={`/o/${orgId}/refunds/${r.id}`}>
                        <code>{shortId(r.id)}</code>
                      </a>
                    </td>
                    <td>{formatAmount(r.amount, r.currency, locale)}</td>
                    <td>
                      <span className={`badge badge-${r.status}`}>{r.status}</span>
                    </td>
                    <td>{when(r.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="hint">{t.refundCreateUnavailable}</p>
      </section>

      <section className="card" aria-labelledby="payment-sessions-title">
        <h2 id="payment-sessions-title">
          {t.relatedSessions} <span className="count">({sessions.length})</span>
        </h2>
        {sessions.length === 0 ? (
          <p className="empty">{t.sessionsEmpty}</p>
        ) : (
          <div className="table-wrap">
            <table>
              <caption className="sr-only">{t.relatedSessions}</caption>
              <thead>
                <tr>
                  <th scope="col">{t.colId}</th>
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
