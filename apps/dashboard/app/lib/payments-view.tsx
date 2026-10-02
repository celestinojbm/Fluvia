import { formatAmount, MESSAGES, type Locale } from '../messages';
import type { CheckoutSession, PaymentIntent, Refund, TimelineKind } from './api';
import { paymentTimeline } from './api';
import { CreateRefundForm } from './payment-actions';
import { isChargedStatus } from './pos-receipt-contract';
import { captureMethodLabel, StatusBadge, statusLabel, type StatusKind } from './status-labels';
import { FlowNav } from './flow-nav';

/**
 * Vistas de pagos (F6.5A) — presentación pura (server components, renderizables
 * en jsdom). SOLO LECTURA: no hay acción mutante en esta superficie; el permiso
 * que la gobierna es `payments:read` (todo rol) y el API es la fuente de verdad.
 * La línea de tiempo se DERIVA de timestamps persistidos del intent y sus
 * recursos relacionados — no simula un event-log que el API no tiene.
 */

const TL_KIND: Record<TimelineKind, StatusKind> = {
  payment_created: 'intent',
  session_created: 'session',
  session_completed: 'session',
  refund_created: 'refund',
};

function shortId(v: string): string {
  return v.length > 12 ? `${v.slice(0, 8)}…${v.slice(-4)}` : v;
}
function when(v: string | null): string {
  return v ? `${v.replace('T', ' ').slice(0, 16)} UTC` : '—';
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
  // Resumen por estado (conteo, nunca suma de monedas distintas).
  const byStatus = new Map<string, number>();
  for (const p of intents) byStatus.set(p.status, (byStatus.get(p.status) ?? 0) + 1);
  return (
    <main className="dash fx-page" aria-labelledby="payments-title">
      <FlowNav orgId={orgId} locale={locale} current="payments" signOutHref={signOutHref} />
      <header className="fx-head">
        <div>
          <p className="fx-crumb">
            <a href={`/o/${orgId}`}>{t.backToDashboard}</a>
          </p>
          <h1 id="payments-title">{t.paymentsTitle}</h1>
        </div>
      </header>

      {intents.length > 0 ? (
        <ul className="fx-summary-line" aria-label={t.colStatus}>
          <li>
            <strong>{intents.length}</strong> {t.paymentsTitle.toLowerCase()}
          </li>
          {[...byStatus.entries()].map(([status, n]) => (
            <li key={status}>
              <strong>{n}</strong> · {statusLabel('intent', status, locale).toLowerCase()}
            </li>
          ))}
        </ul>
      ) : null}

      <section className="fx-panel" aria-labelledby="payments-title">
        {intents.length === 0 ? (
          <p className="fx-empty">{t.paymentsEmpty}</p>
        ) : (
          <div className="fx-table-wrap">
            <table className="fx-table is-stack">
              <caption className="sr-only">{t.paymentsTitle}</caption>
              <thead>
                <tr>
                  <th scope="col" className="num">
                    {t.colAmount}
                  </th>
                  <th scope="col">{t.colStatus}</th>
                  <th scope="col">{t.colPayment}</th>
                  <th scope="col">{t.colMerchant}</th>
                  <th scope="col">{t.colCreated}</th>
                </tr>
              </thead>
              <tbody>
                {intents.map((p) => (
                  <tr key={p.id}>
                    <td className="num is-lead fx-amount-lead" data-label={t.colAmount}>
                      {formatAmount(p.amount, p.currency, locale)}
                    </td>
                    <td data-label={t.colStatus}>
                      <StatusBadge kind="intent" status={p.status} locale={locale} />
                    </td>
                    <td data-label={t.colPayment}>
                      <a href={`/o/${orgId}/payments/${p.id}`} className="fx-idlink">
                        <code>{shortId(p.id)}</code>
                      </a>
                    </td>
                    <td data-label={t.colMerchant}>
                      <code className="fx-code">{shortId(p.merchant_id)}</code>
                    </td>
                    <td data-label={t.colCreated}>{when(p.created_at)}</td>
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
  canManage = false,
}: {
  intent: PaymentIntent;
  /** Refunds YA filtrados por el API (`?payment_intent_id=`). */
  refunds: Refund[];
  /** Sesiones YA filtradas a este intent (`sessionsForIntent`). */
  sessions: CheckoutSession[];
  orgId: string;
  locale: Locale;
  signOutHref: string;
  /** El operador puede crear reembolsos (rol con reconciliation:manage). */
  canManage?: boolean;
}) {
  const t = MESSAGES[locale];
  const tlLabel: Record<TimelineKind, string> = {
    payment_created: t.tlPaymentCreated,
    session_created: t.tlSessionCreated,
    session_completed: t.tlSessionCompleted,
    refund_created: t.tlRefundCreated,
  };
  const timeline = paymentTimeline(intent, refunds, sessions);
  // Continuidad del recorrido: justificante solo de un cobro CONFIRMADO (misma
  // regla que el BFF del justificante) y el POS sigue el checkout más reciente.
  const charged = isChargedStatus(intent.status);
  const latestSession =
    [...sessions].sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null;
  const lang = locale === 'en' ? '?lang=en' : '';
  const rows: Array<{ label: string; value: string }> = [
    { label: t.colPayment, value: intent.id },
    { label: t.colMerchant, value: intent.merchant_id },
    { label: t.colAmount, value: formatAmount(intent.amount, intent.currency, locale) },
    { label: t.fldCaptured, value: formatAmount(intent.amount_captured, intent.currency, locale) },
    { label: t.fldRefunded, value: formatAmount(intent.amount_refunded, intent.currency, locale) },
    { label: t.fldCaptureMethod, value: captureMethodLabel(intent.capture_method, locale) },
    { label: t.fldFailureCode, value: intent.failure_code ?? '—' },
    { label: t.colCreated, value: when(intent.created_at) },
  ];
  return (
    <main className="dash fx-page" aria-labelledby="payment-detail-title">
      <FlowNav orgId={orgId} locale={locale} current={null} signOutHref={signOutHref} />
      <header className="fx-head">
        <div>
          <p className="fx-crumb">
            <a href={`/o/${orgId}/payments`}>{t.backToList}</a>
          </p>
          <h1 id="payment-detail-title">{t.paymentDetailTitle}</h1>
        </div>
        {(charged || latestSession) && (
          <div className="fx-actions" role="group" aria-label={t.detailActionsLabel}>
            {charged && (
              <a
                className="fx-btn fx-btn-primary"
                href={`/o/${orgId}/pos/receipts/${intent.id}${lang}`}
                data-testid="payment-receipt-link"
              >
                {t.detailReceipt}
              </a>
            )}
            {latestSession && (
              <a
                className="fx-btn"
                href={`/o/${orgId}/pos?${locale === 'en' ? 'lang=en&' : ''}session=${latestSession.id}`}
                data-testid="payment-pos-link"
              >
                {t.detailOpenPos}
              </a>
            )}
          </div>
        )}
      </header>

      <section className="fx-amount-band" aria-label={t.colAmount}>
        <p className="fx-amount-band-value">
          {formatAmount(intent.amount, intent.currency, locale)}
        </p>
        <StatusBadge kind="intent" status={intent.status} locale={locale} showCode />
      </section>

      <div className="fx-grid fx-grid-main">
        <section className="fx-panel" aria-labelledby="payment-fields-title">
          <header>
            <h2 id="payment-fields-title">{t.paymentDetailTitle}</h2>
          </header>
          <div className="fx-panel-body">
            <dl className="fx-dl">
              {rows.map((r) => (
                <div key={r.label} className="fx-dl-row">
                  <dt>{r.label}</dt>
                  <dd>
                    <code className="fx-code">{r.value}</code>
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section className="fx-panel" aria-labelledby="payment-timeline-title">
          <header>
            <h2 id="payment-timeline-title">{t.timelineTitle}</h2>
          </header>
          <div className="fx-panel-body">
            <ol className="fx-timeline" aria-labelledby="payment-timeline-title">
              {timeline.map((e, i) => (
                <li key={`${e.kind}-${e.refId}-${i}`}>
                  <strong>{tlLabel[e.kind]}</strong>
                  <span>
                    {when(e.at)} · <code>{shortId(e.refId)}</code>{' '}
                  </span>
                  <StatusBadge kind={TL_KIND[e.kind]} status={e.status} locale={locale} />
                </li>
              ))}
            </ol>
          </div>
        </section>
      </div>

      <section className="fx-panel fx-section" aria-labelledby="payment-refunds-title">
        <div className="fx-panel-body">
          <h2 id="payment-refunds-title">
            {t.relatedRefunds} <span className="count">({refunds.length})</span>
          </h2>
          {refunds.length === 0 ? (
            <p className="empty">{t.refundsEmpty}</p>
          ) : (
            <div
              className="table-wrap"
              tabIndex={0}
              role="group"
              aria-label="Tabla (desplazable con teclado)"
            >
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
                        <StatusBadge kind="refund" status={r.status} locale={locale} />
                      </td>
                      <td>{when(r.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {canManage ? (
            <CreateRefundForm
              orgId={orgId}
              paymentIntentId={intent.id}
              currency={intent.currency}
              locale={locale}
            />
          ) : (
            <p className="hint">{t.refundCreateNoRole}</p>
          )}
        </div>
      </section>

      <section className="fx-panel fx-section" aria-labelledby="payment-sessions-title">
        <div className="fx-panel-body">
          <h2 id="payment-sessions-title">
            {t.relatedSessions} <span className="count">({sessions.length})</span>
          </h2>
          {sessions.length === 0 ? (
            <p className="empty">{t.sessionsEmpty}</p>
          ) : (
            <div
              className="table-wrap"
              tabIndex={0}
              role="group"
              aria-label="Tabla (desplazable con teclado)"
            >
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
                        <StatusBadge kind="session" status={s.status} locale={locale} />
                      </td>
                      <td>{when(s.created_at)}</td>
                      <td>{when(s.expires_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
      <p className="notice">{t.sandboxNotice}</p>
    </main>
  );
}
