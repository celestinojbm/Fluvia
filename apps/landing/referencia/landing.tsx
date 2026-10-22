import Link from 'next/link';
import { CardRail } from './card-rail';
import { CATEGORIES } from './categories';
import { Icon } from './icons';
import { PhotoCard } from './public-cards';
import { PublicShell, SectionHead } from './public-shell';

/**
 * Portada pública. Sin cifras, testimonios, promociones ni comercios
 * inventados: describe lo que el producto hace y enlaza a pantallas reales.
 */
export function Landing() {
  return (
    <PublicShell current="/">
      <section className="pb-hero" aria-labelledby="pb-hero-title">
        <div>
          <h1 id="pb-hero-title">Paga en comercios Fluvia con tu saldo o en cuotas.</h1>
          <p className="pb-hero-lead">
            Billetera, tarjeta virtual y cuotas en un mismo lugar. Las cuotas dependen de un límite
            aprobado, y tu dinero y tu crédito se muestran siempre por separado.
          </p>
          <div className="pb-entries">
            <Link className="pb-entry pb-entry-dark" href="/personal/entrar">
              <strong>
                Para personas <Icon name="arrow-right" />
              </strong>
              <span>Abre tu cuenta Personal, ingresa saldo y pide tu tarjeta virtual.</span>
            </Link>
            <Link className="pb-entry" href="/comercios">
              <strong>
                Para comercios <Icon name="arrow-right" />
              </strong>
              <span>Cobra en mostrador o con enlace y aparece en «Dónde comprar».</span>
            </Link>
          </div>
        </div>
        <figure className="pb-hero-photo">
          <img
            src="/presentacion/portada.jpg"
            alt="Mostrador de una cafetería con cafeteras y frascos"
            width={640}
            height={800}
          />
          <figcaption>
            <span className="fl-chip-lime">Foto ilustrativa</span>
          </figcaption>
        </figure>
      </section>

      <section className="pb-sec" aria-labelledby="categorias">
        <SectionHead
          id="categorias"
          title="Explora por categoría"
          lead="Encuentra comercios que publicaron su perfil en Fluvia."
          more={{ href: '/donde-comprar', label: 'Ver directorio' }}
        />
        <CardRail label="Categorías">
          {CATEGORIES.map((c) => (
            <li key={c.slug}>
              <PhotoCard
                href={`/donde-comprar?categoria=${c.slug}`}
                photo={c.photo}
                alt={c.alt}
                title={c.label}
                text={c.blurb}
              />
            </li>
          ))}
        </CardRail>
      </section>

      <section className="pb-sec" aria-labelledby="formas">
        <SectionHead id="formas" title="Paga como prefieras" />
        <div className="pb-cols pb-cols-3">
          <article className="pb-panel">
            <h3>Billetera</h3>
            <p>
              Tu saldo propio. Ingresa, envía y retira; lo retenido y la garantía se ven aparte.
            </p>
            <Link className="pb-more" href="/conoce/billetera">
              Cómo funciona la billetera <Icon name="arrow-right" size={16} />
            </Link>
          </article>
          <article className="pb-panel">
            <h3>Tarjeta virtual</h3>
            <p>Para pagar en comercios Fluvia. La bloqueas y le pones límites cuando quieras.</p>
            <Link className="pb-more" href="/conoce/tarjeta">
              Cómo funciona la tarjeta <Icon name="arrow-right" size={16} />
            </Link>
          </article>
          <article className="pb-panel pb-panel-credit">
            <h3>Cuotas</h3>
            <p>
              Con un límite aprobado, divides una compra en cuotas. El crédito no es saldo propio.
            </p>
            <Link className="pb-more" href="/conoce/cuotas">
              Cómo funcionan las cuotas <Icon name="arrow-right" size={16} />
            </Link>
          </article>
        </div>
      </section>

      <section className="pb-sec" aria-labelledby="como">
        <SectionHead
          id="como"
          title="Cómo funciona"
          more={{ href: '/como-funciona', label: 'Ver los pasos' }}
        />
        <ol className="pb-steps">
          <li>
            <strong>Crea tu cuenta Personal</strong>
            <p>Con tu correo y una contraseña.</p>
          </li>
          <li>
            <strong>Ingresa saldo o solicita un límite</strong>
            <p>El límite se evalúa con tu garantía y tu historial en Fluvia.</p>
          </li>
          <li>
            <strong>Paga en un comercio Fluvia</strong>
            <p>Con tu saldo, tu tarjeta virtual o en cuotas si tienes límite.</p>
          </li>
        </ol>
      </section>

      <section className="pb-sec" aria-labelledby="comercio">
        <div className="pb-panel pb-panel-dark">
          <h2 id="comercio">¿Tienes un comercio?</h2>
          <p>
            Cobra con terminal, enlace de pago o código. Publica tu perfil en el directorio solo si
            tú lo decides.
          </p>
          <div className="pb-actions">
            <Link className="pb-btn pb-btn-lime" href="/signup">
              Registrar mi comercio
            </Link>
            <Link className="pb-btn pb-btn-on-dark" href="/comercios">
              Saber más
            </Link>
          </div>
        </div>
      </section>

      <section className="pb-sec" aria-labelledby="ayuda">
        <div className="pb-state">
          <h2 id="ayuda">¿Dudas?</h2>
          <p>
            Guías paso a paso en el centro de ayuda. Dentro de Personal y de Comercio también puedes
            preguntarle al asistente Fluvia.
          </p>
          <Link className="pb-btn pb-btn-ghost" href="/ayuda">
            <Icon name="help" /> Ir al centro de ayuda
          </Link>
        </div>
      </section>
    </PublicShell>
  );
}
