import { formatAmount, MESSAGES, type Locale } from '../messages';
import type { Dispute } from './api';

/**
 * Vistas de disputas/chargebacks (F4-08d) — presentación pura (server
 * components, renderizables en jsdom). Solo lectura: el operador monitorea las
 * disputas que el banco abre y resuelve. Mientras no son terminales
 * (`open`/`under_review`) los fondos disputados están APARTADOS de la reserva
 * del comercio. Tablas accesibles con `th scope`/`caption`.
 */

function shortId(v: string): string {
  return v.length > 12 ? `${v.slice(0, 8)}…${v.slice(-4)}` : v;
}
function when(v: string | null): string {
  return v ? v.replace('T', ' ').slice(0, 16) : '—';
}
/** open / under_review: la disputa está viva y los fondos siguen apartados. */
function isHeld(status: string): boolean {
  return status === 'open' || status === 'under_review';
}

export function DisputesList({
  disputes,
  orgId,
  locale,
  signOutHref,
}: {
  disputes: Dispute[];
  orgId: string;
  locale: Locale;
  signOutHref: string;
}) {
  const t = MESSAGES[locale];
  return (
    <main className="dash" aria-labelledby="disputes-title">
      <header className="dash-head">
        <div>
          <h1 id="disputes-title">{t.disputesTitle}</h1>
          <p className="org">
            <a href={`/o/${orgId}`}>{t.backToDashboard}</a>
          </p>
        </div>
        <a className="signout" href={signOutHref}>
          {t.signOut}
        </a>
      </header>

      <section className="card">
        {disputes.length === 0 ? (
          <p className="empty">{t.disputesEmpty}</p>
        ) : (
          <div className="table-wrap">
            <table>
              <caption className="sr-only">{t.disputesTitle}</caption>
              <thead>
                <tr>
                  <th scope="col">{t.colDispute}</th>
                  <th scope="col">{t.colMerchant}</th>
                  <th scope="col">{t.colAmount}</th>
                  <th scope="col">{t.colStatus}</th>
                  <th scope="col">{t.colCreated}</th>
                </tr>
              </thead>
              <tbody>
                {disputes.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <a href={`/o/${orgId}/disputes/${d.id}`}>
                        <code>{shortId(d.id)}</code>
                      </a>
                    </td>
                    <td>
                      <code>{shortId(d.merchant_id)}</code>
                    </td>
                    <td>{formatAmount(d.amount, d.currency, locale)}</td>
                    <td>
                      <span className={`badge badge-${d.status}`}>{d.status}</span>
                    </td>
                    <td>{when(d.created_at)}</td>
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

export function DisputesDetail({
  dispute,
  orgId,
  locale,
  signOutHref,
}: {
  dispute: Dispute;
  orgId: string;
  locale: Locale;
  signOutHref: string;
}) {
  const t = MESSAGES[locale];
  const rows: Array<{ label: string; value: string }> = [
    { label: t.colDispute, value: dispute.id },
    { label: t.colMerchant, value: dispute.merchant_id },
    { label: t.colAmount, value: formatAmount(dispute.amount, dispute.currency, locale) },
    { label: t.colCreated, value: when(dispute.created_at) },
    { label: t.disputeReason, value: dispute.reason ?? '—' },
    { label: t.disputeProviderRef, value: dispute.provider_ref ?? '—' },
  ];
  return (
    <main className="dash" aria-labelledby="dispute-detail-title">
      <header className="dash-head">
        <div>
          <h1 id="dispute-detail-title">{t.disputes}</h1>
          <p className="org">
            <a href={`/o/${orgId}/disputes`}>{t.backToDashboard}</a> ·{' '}
            {formatAmount(dispute.amount, dispute.currency, locale)} ·{' '}
            <span className={`badge badge-${dispute.status}`}>{dispute.status}</span>
          </p>
        </div>
        <a className="signout" href={signOutHref}>
          {t.signOut}
        </a>
      </header>

      {isHeld(dispute.status) && <p className="notice">{t.disputeHeldHint}</p>}

      <section className="card">
        <div className="table-wrap">
          <table>
            <caption className="sr-only">{t.disputes}</caption>
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
      <p className="notice">{t.sandboxNotice}</p>
    </main>
  );
}
