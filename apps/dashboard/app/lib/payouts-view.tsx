import { formatAmount, MESSAGES, type Locale } from '../messages';
import type { Payout } from './api';

/**
 * Vistas de payouts (F4-07d) — presentación pura (server components,
 * renderizables en jsdom). Solo lectura: el operador monitorea los payouts
 * (money out) y su estado. El estado `indeterminate` significa fondos retenidos
 * en tránsito esperando resolución verificada (V4 §23). Tablas accesibles con
 * `th scope`/`caption`.
 */

function shortId(v: string): string {
  return v.length > 12 ? `${v.slice(0, 8)}…${v.slice(-4)}` : v;
}
function when(v: string | null): string {
  return v ? v.replace('T', ' ').slice(0, 16) : '—';
}

export function PayoutsList({
  payouts,
  orgId,
  locale,
  signOutHref,
}: {
  payouts: Payout[];
  orgId: string;
  locale: Locale;
  signOutHref: string;
}) {
  const t = MESSAGES[locale];
  return (
    <main className="dash" aria-labelledby="payouts-title">
      <header className="dash-head">
        <div>
          <h1 id="payouts-title">{t.payoutsTitle}</h1>
          <p className="org">
            <a href={`/o/${orgId}`}>{t.backToDashboard}</a>
          </p>
        </div>
        <a className="signout" href={signOutHref}>
          {t.signOut}
        </a>
      </header>

      <section className="card">
        {payouts.length === 0 ? (
          <p className="empty">{t.payoutsEmpty}</p>
        ) : (
          <div className="table-wrap">
            <table>
              <caption className="sr-only">{t.payoutsTitle}</caption>
              <thead>
                <tr>
                  <th scope="col">{t.colPayout}</th>
                  <th scope="col">{t.colMerchant}</th>
                  <th scope="col">{t.colAmount}</th>
                  <th scope="col">{t.colStatus}</th>
                  <th scope="col">{t.colCreated}</th>
                </tr>
              </thead>
              <tbody>
                {payouts.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <a href={`/o/${orgId}/payouts/${p.id}`}>
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

export function PayoutsDetail({
  payout,
  orgId,
  locale,
  signOutHref,
}: {
  payout: Payout;
  orgId: string;
  locale: Locale;
  signOutHref: string;
}) {
  const t = MESSAGES[locale];
  const rows: Array<{ label: string; value: string }> = [
    { label: t.colPayout, value: payout.id },
    { label: t.colMerchant, value: payout.merchant_id },
    { label: t.colAmount, value: formatAmount(payout.amount, payout.currency, locale) },
    { label: t.colCreated, value: when(payout.created_at) },
    { label: t.payoutReason, value: payout.reason ?? '—' },
    { label: t.payoutFailureCode, value: payout.failure_code ?? '—' },
  ];
  return (
    <main className="dash" aria-labelledby="payout-detail-title">
      <header className="dash-head">
        <div>
          <h1 id="payout-detail-title">{t.payouts}</h1>
          <p className="org">
            <a href={`/o/${orgId}/payouts`}>{t.backToDashboard}</a> ·{' '}
            {formatAmount(payout.amount, payout.currency, locale)} ·{' '}
            <span className={`badge badge-${payout.status}`}>{payout.status}</span>
          </p>
        </div>
        <a className="signout" href={signOutHref}>
          {t.signOut}
        </a>
      </header>

      {payout.status === 'indeterminate' && <p className="notice">{t.payoutIndeterminateHint}</p>}

      <section className="card">
        <div className="table-wrap">
          <table>
            <caption className="sr-only">{t.payouts}</caption>
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
