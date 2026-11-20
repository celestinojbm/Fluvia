import { formatAmount, type Locale } from '../messages';
import { classifySale } from './pos-contract';
import { POS_MESSAGES } from './pos-messages';
import type { RecentChargesResult } from './pos-reads';

/**
 * Panel «Cobros recientes» del POS (presentación pura, server component). Cada
 * fila es una sesión de checkout REAL con el estado de su pago; «Seguir» la
 * reabre en el terminal (`?session=`) y «Detalle» lleva a la página de pago
 * existente. No agrupa por venta: la API no relaciona link→intent (gap G3).
 */

function when(iso: string, locale: Locale): string {
  try {
    return new Date(iso).toLocaleString(locale === 'en' ? 'en-US' : 'es-CO', {
      dateStyle: 'short',
      timeStyle: 'short',
    });
  } catch {
    return iso;
  }
}

export function PosRecentCharges({
  result,
  orgId,
  locale,
}: {
  result: RecentChargesResult;
  orgId: string;
  locale: Locale;
}) {
  const t = POS_MESSAGES[locale];
  const lang = locale === 'en' ? 'lang=en&' : '';
  const refreshHref = `/o/${orgId}/pos${locale === 'en' ? '?lang=en' : ''}`;
  return (
    <section className="card pos-panel pos-recent" aria-labelledby="pos-recent-title">
      <div className="pos-recent-head">
        <h2 id="pos-recent-title">{t.recentTitle}</h2>
        <a className="pos-refresh" href={refreshHref}>
          {t.refreshList}
        </a>
      </div>
      <p className="hint">{t.recentScope}</p>
      {!result.ok ? (
        <p className="error" role="alert">
          {t.recentLoadError}
        </p>
      ) : result.rows.length === 0 ? (
        <p className="empty">{t.recentEmpty}</p>
      ) : (
        <ul className="pos-recent-list">
          {result.rows.map(({ session, payment }) => {
            const phase = payment ? classifySale(session.status, payment.status) : 'unknown';
            return (
              <li key={session.id} className="pos-recent-item">
                <div className="pos-recent-main">
                  <span className="pos-recent-amount">
                    {payment ? formatAmount(payment.amount, payment.currency, locale) : '—'}
                  </span>
                  <span className={`badge pos-phase-${phase}`}>{t.phase[phase]}</span>
                </div>
                <div className="pos-recent-meta">
                  <span>{when(session.created_at, locale)}</span>
                  <span>
                    {t.colCheckout}: <code>{session.status}</code>
                  </span>
                  {payment && (
                    <span>
                      {t.colPayment}: <code>{payment.status}</code>
                    </span>
                  )}
                </div>
                <div className="pos-recent-actions">
                  <a
                    href={`/o/${orgId}/pos?${lang}session=${session.id}`}
                    aria-label={`${t.track} · ${when(session.created_at, locale)}`}
                  >
                    {t.track}
                  </a>
                  {payment && (
                    <a
                      href={`/o/${orgId}/payments/${payment.id}${locale === 'en' ? '?lang=en' : ''}`}
                      aria-label={`${t.detail} · ${when(session.created_at, locale)}`}
                    >
                      {t.detail}
                    </a>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
