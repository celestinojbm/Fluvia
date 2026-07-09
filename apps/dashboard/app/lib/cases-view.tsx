import { formatAmount, formatMinor, MESSAGES, type Locale } from '../messages';
import {
  liveAdjustment,
  type CaseAdjustment,
  type CaseSeverity,
  type CaseStatus,
  type OperationalCase,
  type OperationalCaseDetail,
} from './api';
import { AckButton, AdjustmentDecision, ProposeForm, ResolveForm } from './case-actions';

/**
 * Vistas de casos operativos + ajustes con four-eyes (F4-03c-ii). La lista y el
 * marco del detalle son presentación pura (server components, renderizables en
 * jsdom); las ACCIONES (acknowledge/resolve/propose/approve/reject) son islas
 * cliente. Tablas accesibles (`caption`, `th scope`). Solo se muestran acciones a
 * roles con `reconciliation:manage` (`canManage`, hint de UX); la API decide.
 */

function shortId(v: string): string {
  return v.length > 12 ? `${v.slice(0, 8)}…${v.slice(-4)}` : v;
}
function when(v: string | null): string {
  return v ? v.replace('T', ' ').slice(0, 10) : '—';
}

function severityLabel(sev: CaseSeverity, t: (typeof MESSAGES)[Locale]): string {
  return { low: t.sevLow, medium: t.sevMedium, high: t.sevHigh, critical: t.sevCritical }[sev];
}
function SeverityBadge({ sev, t }: { sev: CaseSeverity; t: (typeof MESSAGES)[Locale] }) {
  return <span className={`badge sev-${sev}`}>{severityLabel(sev, t)}</span>;
}
function StatusBadge({ status }: { status: CaseStatus }) {
  return <span className={`badge badge-${status}`}>{status}</span>;
}

const CASE_FILTERS: Array<{
  value?: CaseStatus;
  key: 'filterAll' | 'filterOpen' | 'filterAcknowledged' | 'filterResolved';
}> = [
  { value: undefined, key: 'filterAll' },
  { value: 'open', key: 'filterOpen' },
  { value: 'acknowledged', key: 'filterAcknowledged' },
  { value: 'resolved', key: 'filterResolved' },
];

export function CasesList({
  cases,
  orgId,
  locale,
  activeStatus,
  signOutHref,
}: {
  cases: OperationalCase[];
  orgId: string;
  locale: Locale;
  activeStatus?: CaseStatus;
  signOutHref: string;
}) {
  const t = MESSAGES[locale];
  const langQ = locale === 'en' ? '&lang=en' : '';
  return (
    <main className="dash" aria-labelledby="cases-title">
      <header className="dash-head">
        <div>
          <h1 id="cases-title">{t.casesTitle}</h1>
          <p className="org">
            <a href={`/o/${orgId}`}>{t.backToDashboard}</a>
          </p>
        </div>
        <a className="signout" href={signOutHref}>
          {t.signOut}
        </a>
      </header>

      <nav className="filters" aria-label={t.colStatus}>
        {CASE_FILTERS.map((f) => {
          const href = `/o/${orgId}/cases${f.value ? `?status=${f.value}` : ''}${
            f.value ? langQ : locale === 'en' ? '?lang=en' : ''
          }`;
          const active = activeStatus === f.value;
          return (
            <a
              key={f.key}
              href={href}
              className={`filter${active ? ' filter-active' : ''}`}
              aria-current={active ? 'page' : undefined}
            >
              {t[f.key]}
            </a>
          );
        })}
      </nav>

      <section className="card">
        {cases.length === 0 ? (
          <p className="empty">{t.casesEmpty}</p>
        ) : (
          <div className="table-wrap">
            <table>
              <caption className="sr-only">{t.casesTitle}</caption>
              <thead>
                <tr>
                  <th scope="col">{t.colCase}</th>
                  <th scope="col">{t.colType}</th>
                  <th scope="col">{t.colSeverity}</th>
                  <th scope="col">{t.colStatus}</th>
                  <th scope="col">{t.fldProviderRef}</th>
                  <th scope="col">{t.colCreated}</th>
                </tr>
              </thead>
              <tbody>
                {cases.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <a href={`/o/${orgId}/cases/${c.id}${locale === 'en' ? '?lang=en' : ''}`}>
                        <code>{shortId(c.id)}</code>
                      </a>
                    </td>
                    <td>{c.case_type}</td>
                    <td>
                      <SeverityBadge sev={c.severity} t={t} />
                    </td>
                    <td>
                      <StatusBadge status={c.status} />
                    </td>
                    <td>{c.provider_ref ? <code>{c.provider_ref}</code> : '—'}</td>
                    <td>{when(c.created_at)}</td>
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

function AdjustmentsTable({
  adjustments,
  orgId,
  locale,
  canManage,
}: {
  adjustments: CaseAdjustment[];
  orgId: string;
  locale: Locale;
  canManage: boolean;
}) {
  const t = MESSAGES[locale];
  if (adjustments.length === 0) return <p className="empty">{t.noAdjustments}</p>;
  const dirLabel = (d: CaseAdjustment['direction']) =>
    d === 'debit_differences' ? t.dirDebit : t.dirCredit;
  return (
    <div className="table-wrap">
      <table>
        <caption className="sr-only">{t.adjustmentsTitle}</caption>
        <thead>
          <tr>
            <th scope="col">{t.colAmount}</th>
            <th scope="col">{t.colDirection}</th>
            <th scope="col">{t.colReason}</th>
            <th scope="col">{t.colStatus}</th>
            <th scope="col">{t.colProposedBy}</th>
            {canManage && <th scope="col">{t.colAction}</th>}
          </tr>
        </thead>
        <tbody>
          {adjustments.map((a) => (
            <tr key={a.id}>
              <td>{formatAmount(a.amount, a.currency, locale)}</td>
              <td>{dirLabel(a.direction)}</td>
              <td>{a.reason}</td>
              <td>
                <span className={`badge badge-${a.status}`}>{a.status}</span>
              </td>
              <td>
                <code>{shortId(a.proposed_by_user_id)}</code>
              </td>
              {canManage && (
                <td>
                  {a.status === 'proposed' ? (
                    <AdjustmentDecision orgId={orgId} adjustmentId={a.id} locale={locale} />
                  ) : (
                    '—'
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CaseDetail({
  kase,
  orgId,
  locale,
  canManage,
  signOutHref,
}: {
  kase: OperationalCaseDetail;
  orgId: string;
  locale: Locale;
  canManage: boolean;
  signOutHref: string;
}) {
  const t = MESSAGES[locale];
  const live = liveAdjustment(kase.adjustments);
  const canAcknowledge = canManage && kase.status === 'open';
  const canWork = canManage && kase.status !== 'resolved';
  // El monto de la discrepancia (provider vs ledger) siembra la propuesta.
  const suggested = kase.provider_amount ?? kase.ledger_amount ?? null;

  return (
    <main className="dash" aria-labelledby="case-title">
      <header className="dash-head">
        <div>
          <h1 id="case-title">{t.caseDetail}</h1>
          <p className="org">
            <a href={`/o/${orgId}/cases${locale === 'en' ? '?lang=en' : ''}`}>
              {t.backToDashboard}
            </a>{' '}
            · <code>{shortId(kase.id)}</code> · <SeverityBadge sev={kase.severity} t={t} />{' '}
            <StatusBadge status={kase.status} />
          </p>
        </div>
        <a className="signout" href={signOutHref}>
          {t.signOut}
        </a>
      </header>

      <section className="card" aria-label={t.caseDetail}>
        <dl className="kv">
          <dt>{t.colType}</dt>
          <dd>{kase.case_type}</dd>
          <dt>{t.fldDiscrepancy}</dt>
          <dd>{kase.discrepancy_status ?? '—'}</dd>
          <dt>{t.fldProviderRef}</dt>
          <dd>{kase.provider_ref ? <code>{kase.provider_ref}</code> : '—'}</dd>
          <dt>{t.colLedger}</dt>
          <dd>{formatMinor(kase.ledger_amount, locale)}</dd>
          <dt>{t.colProviderAmount}</dt>
          <dd>{formatMinor(kase.provider_amount, locale)}</dd>
          {kase.resolution && (
            <>
              <dt>{t.fldResolution}</dt>
              <dd>{kase.resolution}</dd>
            </>
          )}
        </dl>
        {canAcknowledge && <AckButton orgId={orgId} caseId={kase.id} locale={locale} />}
      </section>

      <section className="card" aria-labelledby="adj-h">
        <h2 id="adj-h">{t.adjustmentsTitle}</h2>
        <AdjustmentsTable
          adjustments={kase.adjustments}
          orgId={orgId}
          locale={locale}
          canManage={canManage}
        />
        {canWork &&
          (live ? (
            <p className="hint">{t.liveAdjustmentNote}</p>
          ) : (
            <ProposeForm orgId={orgId} caseId={kase.id} locale={locale} defaultAmount={suggested} />
          ))}
      </section>

      {canWork && (
        <section className="card" aria-label={t.resolveAction}>
          <ResolveForm orgId={orgId} caseId={kase.id} locale={locale} />
        </section>
      )}
      <p className="notice">{t.sandboxNotice}</p>
    </main>
  );
}
