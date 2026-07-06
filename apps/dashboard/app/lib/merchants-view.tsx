import { MESSAGES, type Locale } from '../messages';
import type { Merchant } from './api';

/**
 * Vista «buscar comercios» del panel admin mínimo (F4-04a). Presentación pura
 * (server component, renderizable en jsdom). La búsqueda es un `<form method=get>`
 * accesible — sin JS: escribir + enviar recarga con `?q=`, el filtrado ocurre
 * server-side (mismo patrón que el filtro por estado de los casos). Solo lectura.
 */

function shortId(v: string): string {
  return v.length > 12 ? `${v.slice(0, 8)}…${v.slice(-4)}` : v;
}
function when(v: string): string {
  return v ? v.replace('T', ' ').slice(0, 10) : '—';
}

function StatusBadge({ status, locale }: { status: Merchant['status']; locale: Locale }) {
  const t = MESSAGES[locale];
  const label = status === 'active' ? t.merchantActive : t.merchantFrozen;
  return <span className={`badge badge-${status}`}>{label}</span>;
}

export function MerchantsList({
  merchants,
  hasAny,
  orgId,
  query,
  locale,
  signOutHref,
}: {
  /** Lista YA filtrada por `query`. */
  merchants: Merchant[];
  /** ¿La organización tiene algún comercio (antes de filtrar)? Distingue
   * «sin comercios» de «sin coincidencias». */
  hasAny: boolean;
  orgId: string;
  query: string;
  locale: Locale;
  signOutHref: string;
}) {
  const t = MESSAGES[locale];
  return (
    <main className="dash" aria-labelledby="merchants-title">
      <header className="dash-head">
        <div>
          <h1 id="merchants-title">{t.merchantsTitle}</h1>
          <p className="org">
            <a href={`/o/${orgId}`}>{t.backToDashboard}</a>
          </p>
        </div>
        <a className="signout" href={signOutHref}>
          {t.signOut}
        </a>
      </header>

      <section className="card">
        <form className="search" method="get" role="search" action={`/o/${orgId}/merchants`}>
          {locale === 'en' && <input type="hidden" name="lang" value="en" />}
          <label htmlFor="merchant-q">{t.searchLabel}</label>
          <div className="search-row">
            <input
              id="merchant-q"
              type="search"
              name="q"
              defaultValue={query}
              placeholder={t.searchPlaceholder}
              autoComplete="off"
            />
            <button type="submit" className="btn">
              {t.searchAction}
            </button>
            {query && (
              <a
                className="filter"
                href={`/o/${orgId}/merchants${locale === 'en' ? '?lang=en' : ''}`}
              >
                {t.searchClear}
              </a>
            )}
          </div>
        </form>

        {!hasAny ? (
          <p className="empty">{t.merchantsEmpty}</p>
        ) : merchants.length === 0 ? (
          <p className="empty">{t.merchantsNoMatch}</p>
        ) : (
          <div className="table-wrap">
            <table>
              <caption className="sr-only">{t.merchantsTitle}</caption>
              <thead>
                <tr>
                  <th scope="col">{t.colName}</th>
                  <th scope="col">{t.colId}</th>
                  <th scope="col">{t.colCountry}</th>
                  <th scope="col">{t.colCurrency}</th>
                  <th scope="col">{t.colStatus}</th>
                  <th scope="col">{t.colCreated}</th>
                </tr>
              </thead>
              <tbody>
                {merchants.map((m) => (
                  <tr key={m.id}>
                    <td>{m.name}</td>
                    <td>
                      <code>{shortId(m.id)}</code>
                    </td>
                    <td>{m.country}</td>
                    <td>{m.defaultCurrency}</td>
                    <td>
                      <StatusBadge status={m.status} locale={locale} />
                    </td>
                    <td>{when(m.createdAt)}</td>
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
