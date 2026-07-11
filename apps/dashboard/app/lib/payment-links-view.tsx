import { formatAmount, MESSAGES, type Locale } from '../messages';
import type { Merchant, PaymentLink } from './api';
import { CopyUrlButton } from './copy-button';
import { CreatePaymentLinkForm } from './payment-actions';

/**
 * Vistas de payment links (F6.5A + F6.5A-bis). Lectura por sesión
 * (`payments:read`) para todo rol; CREAR un link existe ahora también por
 * sesión (`reconciliation:manage`, G2) y el formulario solo se muestra a esos
 * roles (hint de UX — el API es la fuente de verdad). Las sesiones abiertas
 * desde un link siguen sin ser consultables por link (la sesión no expone
 * `payment_link_id`): gap G3, pendiente.
 */

function shortId(v: string): string {
  return v.length > 12 ? `${v.slice(0, 8)}…${v.slice(-4)}` : v;
}
function when(v: string | null): string {
  return v ? v.replace('T', ' ').slice(0, 16) : '—';
}

export function PaymentLinksList({
  links,
  orgId,
  locale,
  signOutHref,
  canManage = false,
  merchants = [],
}: {
  links: PaymentLink[];
  orgId: string;
  locale: Locale;
  signOutHref: string;
  /** El operador puede crear links (rol con reconciliation:manage). */
  canManage?: boolean;
  /** Comercios de la org (para el selector del formulario de creación). */
  merchants?: Merchant[];
}) {
  const t = MESSAGES[locale];
  return (
    <main className="dash" aria-labelledby="links-title">
      <header className="dash-head">
        <div>
          <h1 id="links-title">{t.linksTitle}</h1>
          <p className="org">
            <a href={`/o/${orgId}`}>{t.backToDashboard}</a>
          </p>
        </div>
        <a className="signout" href={signOutHref}>
          {t.signOut}
        </a>
      </header>

      <section className="card">
        {links.length === 0 ? (
          <p className="empty">{t.linksEmpty}</p>
        ) : (
          <div className="table-wrap">
            <table>
              <caption className="sr-only">{t.linksTitle}</caption>
              <thead>
                <tr>
                  <th scope="col">{t.colId}</th>
                  <th scope="col">{t.colMerchant}</th>
                  <th scope="col">{t.colAmount}</th>
                  <th scope="col">{t.colStatus}</th>
                  <th scope="col">{t.colCreated}</th>
                </tr>
              </thead>
              <tbody>
                {links.map((l) => (
                  <tr key={l.id}>
                    <td>
                      <a href={`/o/${orgId}/payment-links/${l.id}`}>
                        <code>{shortId(l.id)}</code>
                      </a>
                    </td>
                    <td>
                      <code>{shortId(l.merchant_id)}</code>
                    </td>
                    <td>{formatAmount(l.amount, l.currency, locale)}</td>
                    <td>
                      <span className={`badge badge-${l.status}`}>{l.status}</span>
                    </td>
                    <td>{when(l.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {canManage ? (
          <CreatePaymentLinkForm orgId={orgId} merchants={merchants} locale={locale} />
        ) : (
          <p className="hint">{t.linkCreateNoRole}</p>
        )}
      </section>
      <p className="notice">{t.sandboxNotice}</p>
    </main>
  );
}

export function PaymentLinkDetail({
  link,
  orgId,
  locale,
  signOutHref,
}: {
  link: PaymentLink;
  orgId: string;
  locale: Locale;
  signOutHref: string;
}) {
  const t = MESSAGES[locale];
  const rows: Array<{ label: string; value: string }> = [
    { label: t.colId, value: link.id },
    { label: t.colMerchant, value: link.merchant_id },
    { label: t.colAmount, value: formatAmount(link.amount, link.currency, locale) },
    { label: t.fldDescription, value: link.description ?? '—' },
    { label: t.colCreated, value: when(link.created_at) },
    { label: t.fldDisabledAt, value: when(link.disabled_at) },
  ];
  return (
    <main className="dash" aria-labelledby="link-detail-title">
      <header className="dash-head">
        <div>
          <h1 id="link-detail-title">{t.linkDetailTitle}</h1>
          <p className="org">
            <a href={`/o/${orgId}/payment-links`}>{t.backToDashboard}</a> ·{' '}
            {formatAmount(link.amount, link.currency, locale)} ·{' '}
            <span className={`badge badge-${link.status}`}>{link.status}</span>
          </p>
        </div>
        <a className="signout" href={signOutHref}>
          {t.signOut}
        </a>
      </header>

      <section className="card">
        <div className="table-wrap">
          <table>
            <caption className="sr-only">{t.linkDetailTitle}</caption>
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
                <th scope="row">{t.fldCheckoutUrl}</th>
                <td className="action-inline">
                  <code>{link.url}</code>
                  <CopyUrlButton url={link.url} locale={locale} />
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
