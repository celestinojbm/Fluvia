import { formatAmount, MESSAGES, type Locale } from '../messages';
import type { Refund } from './api';

/**
 * Vistas de reembolsos (F6.5A) — presentación pura, lectura por sesión
 * (`payments:read`). CREAR un reembolso vive en el DETALLE del pago
 * (F6.5A-bis, `reconciliation:manage`): aquí solo se lista y se enlaza.
 */

function shortId(v: string): string {
  return v.length > 12 ? `${v.slice(0, 8)}…${v.slice(-4)}` : v;
}
function when(v: string | null): string {
  return v ? v.replace('T', ' ').slice(0, 16) : '—';
}

export function RefundsList({
  refunds,
  orgId,
  locale,
  signOutHref,
}: {
  refunds: Refund[];
  orgId: string;
  locale: Locale;
  signOutHref: string;
}) {
  const t = MESSAGES[locale];
  return (
    <main className="dash" aria-labelledby="refunds-title">
      <header className="dash-head">
        <div>
          <h1 id="refunds-title">{t.refundsTitle}</h1>
          <p className="org">
            <a href={`/o/${orgId}`}>{t.backToDashboard}</a>
          </p>
        </div>
        <a className="signout" href={signOutHref}>
          {t.signOut}
        </a>
      </header>

      <section className="card">
        {refunds.length === 0 ? (
          <p className="empty">{t.refundsEmpty}</p>
        ) : (
          <div className="table-wrap">
            <table>
              <caption className="sr-only">{t.refundsTitle}</caption>
              <thead>
                <tr>
                  <th scope="col">{t.colId}</th>
                  <th scope="col">{t.colPayment}</th>
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
                    <td>
                      <a href={`/o/${orgId}/payments/${r.payment_intent_id}`}>
                        <code>{shortId(r.payment_intent_id)}</code>
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
      <p className="notice">{t.sandboxNotice}</p>
    </main>
  );
}

export function RefundDetail({
  refund,
  orgId,
  locale,
  signOutHref,
}: {
  refund: Refund;
  orgId: string;
  locale: Locale;
  signOutHref: string;
}) {
  const t = MESSAGES[locale];
  const rows: Array<{ label: string; value: string }> = [
    { label: t.colId, value: refund.id },
    { label: t.colAmount, value: formatAmount(refund.amount, refund.currency, locale) },
    { label: t.reasonLabel, value: refund.reason ?? '—' },
    { label: t.fldFailureCode, value: refund.failure_code ?? '—' },
    { label: t.colCreated, value: when(refund.created_at) },
  ];
  return (
    <main className="dash" aria-labelledby="refund-detail-title">
      <header className="dash-head">
        <div>
          <h1 id="refund-detail-title">{t.refundDetailTitle}</h1>
          <p className="org">
            <a href={`/o/${orgId}/refunds`}>{t.backToDashboard}</a> ·{' '}
            {formatAmount(refund.amount, refund.currency, locale)} ·{' '}
            <span className={`badge badge-${refund.status}`}>{refund.status}</span>
          </p>
        </div>
        <a className="signout" href={signOutHref}>
          {t.signOut}
        </a>
      </header>

      <section className="card">
        <div className="table-wrap">
          <table>
            <caption className="sr-only">{t.refundDetailTitle}</caption>
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
                  <a href={`/o/${orgId}/payments/${refund.payment_intent_id}`}>
                    <code>{refund.payment_intent_id}</code>
                  </a>
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
