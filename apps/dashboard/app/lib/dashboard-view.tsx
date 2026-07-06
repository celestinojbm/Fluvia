import { formatAmount, MESSAGES, type Locale } from '../messages';
import type { DashboardData } from './api';
import { ResendButton } from './resend-button';

/**
 * Vista del panel de operación (presentación pura, sin interactividad → server
 * component; renderizable en jsdom para tests). Tablas accesibles: `caption`,
 * `th scope="col"`, montos formateados por moneda/locale. Solo LECTURA (F3-09b);
 * la acción de reenvío de webhooks `dead` llega en un incremento posterior.
 */

function shortId(v: unknown): string {
  const s = String(v ?? '');
  return s.length > 12 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s;
}
function money(row: Record<string, unknown>, locale: Locale): string {
  const amount = row.amount;
  const currency = row.currency;
  if (typeof amount === 'number' && typeof currency === 'string') {
    return formatAmount(amount, currency, locale);
  }
  return '—';
}
function when(v: unknown): string {
  const s = String(v ?? '');
  return s ? s.replace('T', ' ').slice(0, 19) : '—';
}

function Section({
  title,
  columns,
  rows,
  empty,
}: {
  title: string;
  columns: string[];
  rows: Array<{ key: string; cells: React.ReactNode[] }>;
  empty: string;
}) {
  return (
    <section className="card" aria-labelledby={`h-${title}`}>
      <h2 id={`h-${title}`}>
        {title} <span className="count">({rows.length})</span>
      </h2>
      {rows.length === 0 ? (
        <p className="empty">{empty}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">{title}</caption>
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c} scope="col">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  {r.cells.map((cell, i) => (
                    <td key={i}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function DashboardView({
  data,
  locale,
  orgId,
  orgName,
  signOutHref,
  canResend = false,
}: {
  data: DashboardData;
  locale: Locale;
  orgId: string;
  orgName: string;
  signOutHref: string;
  /** El operador puede reenviar eventos `dead` (rol con webhooks:manage). */
  canResend?: boolean;
}) {
  const t = MESSAGES[locale];
  const statusBadge = (row: Record<string, unknown>) => (
    <span className={`badge badge-${String(row.status ?? 'unknown')}`}>{String(row.status)}</span>
  );

  return (
    <main className="dash" aria-labelledby="dash-title">
      <header className="dash-head">
        <div>
          <h1 id="dash-title">{t.dashboardTitle}</h1>
          <p className="org">{orgName}</p>
        </div>
        <nav className="dash-nav">
          <a href={`/o/${orgId}/merchants`}>{t.merchants}</a>
          <a href={`/o/${orgId}/cases`}>{t.cases}</a>
          <a href={`/o/${orgId}/reconciliation`}>{t.reconciliation}</a>
          <a className="signout" href={signOutHref}>
            {t.signOut}
          </a>
        </nav>
      </header>

      <Section
        title={t.sectionIntents}
        columns={[t.colId, t.colStatus, t.colAmount, t.colCreated]}
        empty={t.empty}
        rows={data.intents.map((r) => ({
          key: String(r.id),
          cells: [
            <code key="id">{shortId(r.id)}</code>,
            statusBadge(r),
            money(r, locale),
            when(r.created_at),
          ],
        }))}
      />

      <Section
        title={t.sectionRefunds}
        columns={[t.colId, t.colStatus, t.colAmount, t.colCreated]}
        empty={t.empty}
        rows={data.refunds.map((r) => ({
          key: String(r.id),
          cells: [
            <code key="id">{shortId(r.id)}</code>,
            statusBadge(r),
            money(r, locale),
            when(r.created_at),
          ],
        }))}
      />

      <Section
        title={t.sectionSessions}
        columns={[t.colId, t.colStatus, t.colCreated]}
        empty={t.empty}
        rows={data.sessions.map((r) => ({
          key: String(r.id),
          cells: [<code key="id">{shortId(r.id)}</code>, statusBadge(r), when(r.created_at)],
        }))}
      />

      <Section
        title={t.sectionLinks}
        columns={[t.colId, t.colStatus, t.colAmount, t.colCreated]}
        empty={t.empty}
        rows={data.links.map((r) => ({
          key: String(r.id),
          cells: [
            <code key="id">{shortId(r.id)}</code>,
            statusBadge(r),
            money(r, locale),
            when(r.created_at),
          ],
        }))}
      />

      <Section
        title={t.sectionWebhooks}
        columns={[
          t.colId,
          t.colTopic,
          t.colStatus,
          t.colAttempts,
          t.colCreated,
          ...(canResend ? [t.colAction] : []),
        ]}
        empty={t.empty}
        rows={data.webhookEvents.map((r) => ({
          key: String(r.id),
          cells: [
            <code key="id">{shortId(r.id)}</code>,
            String(r.topic ?? '—'),
            statusBadge(r),
            String(r.attempts ?? 0),
            when(r.created_at),
            ...(canResend
              ? [
                  r.status === 'dead' ? (
                    <ResendButton
                      key="resend"
                      orgId={orgId}
                      eventId={String(r.id)}
                      locale={locale}
                    />
                  ) : (
                    <span key="resend">—</span>
                  ),
                ]
              : []),
          ],
        }))}
      />

      <p className="notice">{t.sandboxNotice}</p>
    </main>
  );
}
