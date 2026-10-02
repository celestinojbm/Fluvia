import Link from 'next/link';
import { CATEGORIES, categoryLabel, isCategory } from '../../lib/categories';
import { Icon } from '../../lib/icons';
import { MerchantCard } from '../../lib/public-cards';
import { directoryCities, searchDirectory } from '../../lib/public-api';
import { PublicShell } from '../../lib/public-shell';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Dónde comprar · Fluvia' };

/**
 * «Dónde comprar»: SOLO comercios que publicaron su perfil (opt-in explícito).
 * Búsqueda y filtros por GET (funcionan sin JavaScript); los filtros elegidos
 * se ven y se pueden quitar. Los registros sintéticos llevan «Demo».
 */
export default async function DirectoryPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; categoria?: string; ciudad?: string; desde?: string }>;
}) {
  const sp = await searchParams;
  const q = (sp.q ?? '').trim().slice(0, 80);
  const category = isCategory(sp.categoria) ? sp.categoria : undefined;
  const city = (sp.ciudad ?? '').trim().slice(0, 60) || undefined;
  const offset = Math.min(Math.max(Number.parseInt(sp.desde ?? '0', 10) || 0, 0), 10_000);
  const [result, cities] = await Promise.all([
    searchDirectory({ q: q || undefined, category, city, offset }),
    directoryCities(),
  ]);
  const cityList = cities.kind === 'ok' ? cities.data.data : [];
  const filtered = Boolean(q || category || city);

  const href = (over: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const next = { q: q || undefined, categoria: category, ciudad: city, ...over };
    for (const [k, v] of Object.entries(next)) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `/donde-comprar?${s}` : '/donde-comprar';
  };

  return (
    <PublicShell current="/donde-comprar">
      <div className="pb-page-head">
        <h1>Dónde comprar</h1>
        <p>
          Comercios que publicaron su perfil en Fluvia. Un comercio aparece aquí solo si decide
          publicarse.
        </p>
      </div>

      <form className="pb-filters" method="get" action="/donde-comprar" role="search">
        <div className="pb-filters-row">
          <label className="pb-field">
            Buscar
            <input
              type="search"
              name="q"
              defaultValue={q}
              placeholder="Nombre, zona o lo que vende"
              maxLength={80}
              autoComplete="off"
            />
          </label>
          <label className="pb-field">
            Ciudad
            <select name="ciudad" defaultValue={city ?? ''}>
              <option value="">Todas</option>
              {cityList.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          {category ? <input type="hidden" name="categoria" value={category} /> : null}
          <button type="submit" className="pb-btn pb-btn-dark">
            <Icon name="search" /> Buscar
          </button>
        </div>
        <nav aria-label="Categorías">
          <ul className="pb-chips">
            <li>
              <Link
                href={href({ categoria: undefined })}
                aria-current={!category ? 'true' : undefined}
              >
                Todas
              </Link>
            </li>
            {CATEGORIES.map((c) => (
              <li key={c.slug}>
                <Link
                  href={href({ categoria: c.slug })}
                  aria-current={category === c.slug ? 'true' : undefined}
                >
                  {c.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </form>

      <section aria-labelledby="resultados" aria-live="polite">
        <h2 id="resultados" className="sr-only">
          Resultados
        </h2>
        {result.kind === 'error' || result.kind === 'not_found' ? (
          <div className="pb-state" data-tone="bad" role="alert">
            <h3>No pudimos cargar el directorio</h3>
            <p>Es un fallo temporal de nuestra parte. Tus filtros se conservan.</p>
            <Link className="pb-btn pb-btn-dark" href={href({})}>
              <Icon name="retry" /> Reintentar
            </Link>
          </div>
        ) : result.data.data.length === 0 ? (
          <div className="pb-state">
            <h3>
              {filtered ? 'Sin resultados con estos filtros' : 'Aún no hay comercios publicados'}
            </h3>
            <p>
              {filtered
                ? `No hay comercios publicados${category ? ` en ${categoryLabel(category)}` : ''}${
                    city ? ` en ${city}` : ''
                  }${q ? ` que coincidan con «${q}»` : ''}.`
                : 'Cuando un comercio publique su perfil, aparecerá aquí.'}
            </p>
            {filtered ? (
              <Link className="pb-btn pb-btn-ghost" href="/donde-comprar">
                Quitar filtros
              </Link>
            ) : (
              <Link className="pb-btn pb-btn-ghost" href="/comercios">
                ¿Tienes un comercio? Publícate
              </Link>
            )}
          </div>
        ) : (
          <>
            <p className="pb-count">
              {result.data.data.length === 1
                ? '1 comercio'
                : `${result.data.data.length}${result.data.has_more ? '+' : ''} comercios`}
              {category ? ` en ${categoryLabel(category)}` : ''}
            </p>
            <ul className="pb-grid">
              {result.data.data.map((e) => (
                <li key={e.slug}>
                  <MerchantCard entry={e} />
                </li>
              ))}
            </ul>
            <div className="pb-actions">
              {offset > 0 ? (
                <Link
                  className="pb-btn pb-btn-ghost"
                  href={href({ desde: String(Math.max(offset - 24, 0)) || undefined })}
                >
                  <Icon name="chevron-left" /> Anteriores
                </Link>
              ) : null}
              {result.data.has_more ? (
                <Link className="pb-btn pb-btn-ghost" href={href({ desde: String(offset + 24) })}>
                  Más comercios <Icon name="chevron-right" />
                </Link>
              ) : null}
            </div>
          </>
        )}
      </section>
    </PublicShell>
  );
}
