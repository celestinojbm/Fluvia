import { formatAmount, MESSAGES, type Locale } from '../messages';
import type { ReconciliationEntry, ReconciliationSummary, SettlementReport } from './api';

/**
 * Vistas de conciliación (F4-01c) — presentación pura (server components,
 * renderizables en jsdom). Solo lectura: el operador ve los reportes de
 * liquidación y sus discrepancias. Tablas accesibles con `th scope`/`caption`.
 */

function shortId(v: string): string {
  return v.length > 12 ? `${v.slice(0, 8)}…${v.slice(-4)}` : v;
}
function when(v: string | null): string {
  return v ? v.replace('T', ' ').slice(0, 10) : '—';
}

function SummaryBadges({ summary, locale }: { summary: ReconciliationSummary; locale: Locale }) {
  const t = MESSAGES[locale];
  const items: Array<{ key: keyof ReconciliationSummary; label: string; cls: string }> = [
    { key: 'matched', label: t.reconMatched, cls: 'ok' },
    { key: 'amount_mismatch', label: t.reconAmountMismatch, cls: 'warn' },
    { key: 'missing_in_ledger', label: t.reconMissingLedger, cls: 'bad' },
    { key: 'missing_at_provider', label: t.reconMissingProvider, cls: 'bad' },
  ];
  return (
    <ul className="recon-summary">
      {items.map((i) => (
        <li key={i.key} className={`recon-stat recon-stat-${i.cls}`}>
          <span className="recon-n">{summary[i.key]}</span>
          <span className="recon-label">{i.label}</span>
        </li>
      ))}
    </ul>
  );
}

export function ReconciliationList({
  reports,
  orgId,
  locale,
  signOutHref,
}: {
  reports: SettlementReport[];
  orgId: string;
  locale: Locale;
  signOutHref: string;
}) {
  const t = MESSAGES[locale];
  return (
    <main className="dash" aria-labelledby="recon-title">
      <header className="dash-head">
        <div>
          <h1 id="recon-title">{t.reconTitle}</h1>
          <p className="org">
            <a href={`/o/${orgId}`}>{t.backToDashboard}</a>
          </p>
        </div>
        <a className="signout" href={signOutHref}>
          {t.signOut}
        </a>
      </header>

      <section className="card">
        {reports.length === 0 ? (
          <p className="empty">{t.reconEmpty}</p>
        ) : (
          <div className="table-wrap">
            <table>
              <caption className="sr-only">{t.reconTitle}</caption>
              <thead>
                <tr>
                  <th scope="col">{t.colReport}</th>
                  <th scope="col">{t.colProvider}</th>
                  <th scope="col">{t.colPeriod}</th>
                  <th scope="col">{t.colStatus}</th>
                </tr>
              </thead>
              <tbody>
                {reports.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <a href={`/o/${orgId}/reconciliation/${r.id}`}>
                        <code>{shortId(r.id)}</code>
                      </a>
                    </td>
                    <td>{r.provider}</td>
                    <td>
                      {when(r.period_start)} → {when(r.period_end)}
                    </td>
                    <td>
                      <span className={`badge badge-${r.status}`}>{r.status}</span>
                    </td>
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

export function ReconciliationDetail({
  report,
  entries,
  orgId,
  locale,
  signOutHref,
}: {
  report: SettlementReport;
  entries: ReconciliationEntry[];
  orgId: string;
  locale: Locale;
  signOutHref: string;
}) {
  const t = MESSAGES[locale];
  const money = (v: number | null) => (v === null ? '—' : formatAmount(v, report.currency, locale));
  return (
    <main className="dash" aria-labelledby="recon-detail-title">
      <header className="dash-head">
        <div>
          <h1 id="recon-detail-title">{t.reconciliation}</h1>
          <p className="org">
            <a href={`/o/${orgId}/reconciliation`}>{t.backToDashboard}</a> · {report.provider} ·{' '}
            {when(report.period_start)} → {when(report.period_end)} ·{' '}
            <span className={`badge badge-${report.status}`}>{report.status}</span>
          </p>
        </div>
        <a className="signout" href={signOutHref}>
          {t.signOut}
        </a>
      </header>

      {report.summary && (
        <section className="card" aria-label={t.reconTitle}>
          <SummaryBadges summary={report.summary} locale={locale} />
        </section>
      )}

      <section className="card">
        {entries.length === 0 ? (
          <p className="empty">{t.empty}</p>
        ) : (
          <div className="table-wrap">
            <table>
              <caption className="sr-only">{t.reconciliation}</caption>
              <thead>
                <tr>
                  <th scope="col">{t.colRef}</th>
                  <th scope="col">{t.colStatus}</th>
                  <th scope="col">{t.colLedger}</th>
                  <th scope="col">{t.colProviderAmount}</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.provider_ref}>
                    <td>
                      <code>{e.provider_ref}</code>
                    </td>
                    <td>
                      <span className={`badge recon-badge-${e.status}`}>{e.status}</span>
                    </td>
                    <td>{money(e.ledger_amount)}</td>
                    <td>{money(e.provider_amount)}</td>
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
