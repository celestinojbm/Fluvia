import Link from 'next/link';
import { notFound } from 'next/navigation';
import { categoryLabel, CHANNEL_LABEL } from '../../../lib/categories';
import { Icon } from '../../../lib/icons';
import { directoryEntry } from '../../../lib/public-api';
import { PublicShell } from '../../../lib/public-shell';

export const dynamic = 'force-dynamic';

const DATE = new Intl.DateTimeFormat('es-VE', { day: 'numeric', month: 'long', year: 'numeric' });

/**
 * Ficha pública de un comercio PUBLICADO. Solo lo que el comercio redactó para
 * el público; nada de su organización, ventas ni cuentas. No afirma qué
 * servicios financieros ofrece: eso no se inventa.
 */
export default async function MerchantProfilePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  if (!/^[a-z0-9-]{3,48}$/.test(slug)) notFound();
  const r = await directoryEntry(slug);
  if (r.kind === 'not_found') notFound();

  return (
    <PublicShell current="/donde-comprar">
      <p>
        <Link className="pb-more" href="/donde-comprar">
          <Icon name="chevron-left" size={16} /> Dónde comprar
        </Link>
      </p>
      {r.kind === 'error' ? (
        <div className="pb-state" data-tone="bad" role="alert">
          <h1>No pudimos cargar este comercio</h1>
          <p>Es un fallo temporal de nuestra parte.</p>
          <Link className="pb-btn pb-btn-dark" href={`/donde-comprar/${slug}`}>
            <Icon name="retry" /> Reintentar
          </Link>
        </div>
      ) : (
        <article className="pb-profile" aria-labelledby="pb-merchant">
          <figure className="pb-profile-photo">
            {r.data.photo_ref ? (
              <img src={`/${r.data.photo_ref}`} alt="" width={640} height={800} />
            ) : (
              <span className="pb-card-initial" aria-hidden="true">
                {r.data.display_name.slice(0, 1).toUpperCase()}
              </span>
            )}
          </figure>
          <div className="pb-panel">
            <div className="pb-card-chips">
              <span className="fl-chip-lime">{categoryLabel(r.data.category)}</span>
              {r.data.is_demo ? <span className="pb-chip-demo">Demo</span> : null}
            </div>
            <h1
              id="pb-merchant"
              style={{ margin: 0, fontSize: 'var(--fl-fs-h1)', fontWeight: 800 }}
            >
              {r.data.display_name}
            </h1>
            {r.data.summary ? <p>{r.data.summary}</p> : null}
            <dl className="pb-facts">
              <div>
                <dt>Ciudad</dt>
                <dd>{r.data.city}</dd>
              </div>
              {r.data.area ? (
                <div>
                  <dt>Zona</dt>
                  <dd>{r.data.area}</dd>
                </div>
              ) : null}
              <div>
                <dt>Dónde vende</dt>
                <dd>{r.data.channels.map((c) => CHANNEL_LABEL[c] ?? c).join(' y ')}</dd>
              </div>
              <div>
                <dt>En el directorio desde</dt>
                <dd>{DATE.format(new Date(r.data.published_at))}</dd>
              </div>
            </dl>
            {r.data.is_demo ? (
              <p className="pb-note">
                Comercio de demostración del entorno sandbox: no es un comercio real ni asociado.
              </p>
            ) : null}
            <p>
              Para pagar aquí con Fluvia, entra a tu cuenta Personal. Los medios disponibles los
              confirma el comercio al cobrarte.
            </p>
            <div className="pb-actions">
              <Link className="pb-btn pb-btn-dark" href="/personal/entrar">
                Entrar a Personal
              </Link>
              <Link className="pb-btn pb-btn-ghost" href="/como-funciona">
                Cómo pagar
              </Link>
            </div>
          </div>
        </article>
      )}
    </PublicShell>
  );
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return { title: `${slug} · Dónde comprar · Fluvia` };
}
