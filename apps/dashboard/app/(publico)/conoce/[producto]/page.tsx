import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Icon } from '../../../lib/icons';
import { formatAmount } from '../../../lib/money-format';
import { programTerms, type ProgramTerms } from '../../../lib/public-api';
import { PublicShell } from '../../../lib/public-shell';

export const dynamic = 'force-dynamic';

const PRODUCTS = ['billetera', 'tarjeta', 'cuotas'] as const;
type Product = (typeof PRODUCTS)[number];
const TITLES: Record<Product, string> = {
  billetera: 'Billetera',
  tarjeta: 'Tarjeta virtual',
  cuotas: 'Cuotas',
};

const pct = (bps: number) =>
  `${(bps / 100).toLocaleString('es-VE', { maximumFractionDigits: 2 })} %`;
const money = (minor: number, ccy: string) => formatAmount(minor, ccy, 'es', { code: true });

export function generateStaticParams() {
  return PRODUCTS.map((producto) => ({ producto }));
}

export async function generateMetadata({ params }: { params: Promise<{ producto: string }> }) {
  const { producto } = await params;
  const t = TITLES[producto as Product];
  return { title: t ? `${t} · Fluvia` : 'Fluvia' };
}

/**
 * Explicadores de billetera, tarjeta y cuotas. Las cifras salen de la política
 * ACTIVA del programa (`/v1/public/programs/:id/terms`), no de textos fijos;
 * si la política es la de referencia sintética, se dice.
 */
export default async function ProductPage({ params }: { params: Promise<{ producto: string }> }) {
  const { producto } = await params;
  if (!PRODUCTS.includes(producto as Product)) notFound();
  const product = producto as Product;
  const terms = await programTerms();

  return (
    <PublicShell current={`/conoce/${product}`}>
      <div className="pb-page-head">
        <h1>{TITLES[product]}</h1>
      </div>
      <nav aria-label="Productos" style={{ margin: '12px 0 8px' }}>
        <ul className="pb-chips">
          {PRODUCTS.map((p) => (
            <li key={p}>
              <Link href={`/conoce/${p}`} aria-current={p === product ? 'true' : undefined}>
                {TITLES[p]}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {product === 'billetera' ? <Wallet terms={terms.kind === 'ok' ? terms.data : null} /> : null}
      {product === 'tarjeta' ? <Card terms={terms.kind === 'ok' ? terms.data : null} /> : null}
      {product === 'cuotas' ? (
        terms.kind === 'ok' ? (
          <Installments terms={terms.data} />
        ) : (
          <TermsUnavailable kind={terms.kind} />
        )
      ) : null}
    </PublicShell>
  );
}

function TermsUnavailable({ kind }: { kind: 'error' | 'not_found' }) {
  return (
    <div className="pb-state" data-tone={kind === 'error' ? 'bad' : undefined} role="status">
      <h2>No podemos mostrar las condiciones ahora</h2>
      <p>
        {kind === 'error'
          ? 'Fallo temporal al leer la política vigente. Inténtalo de nuevo.'
          : 'Este despliegue no tiene un programa Personal configurado (FLUVIA_PROGRAM_TENANT_ID).'}
      </p>
      <Link className="pb-btn pb-btn-ghost" href="/conoce/cuotas">
        <Icon name="retry" /> Reintentar
      </Link>
    </div>
  );
}

function SyntheticNote({ terms }: { terms: ProgramTerms }) {
  if (!terms.policy.synthetic && !terms.policy.pending_commercial_validation) return null;
  return (
    <p className="pb-note">
      Condiciones de la política de referencia «{terms.policy.code}» v{terms.policy.version}:
      valores sintéticos del entorno de demostración, pendientes de validación comercial. No son una
      oferta.
    </p>
  );
}

function Wallet({ terms }: { terms: ProgramTerms | null }) {
  return (
    <div className="pb-cols">
      <section className="pb-panel" aria-labelledby="w-que">
        <h2 id="w-que">Tu dinero, separado</h2>
        <p>La billetera guarda tu saldo propio. La pantalla de inicio lo divide en tres partes:</p>
        <dl className="pb-facts">
          <div>
            <dt>Disponible</dt>
            <dd>lo puedes usar ya</dd>
          </div>
          <div>
            <dt>Retenido</dt>
            <dd>reservado por una compra en curso</dd>
          </div>
          <div>
            <dt>Garantía</dt>
            <dd>bloqueado a tu pedido para respaldar un límite</dd>
          </div>
        </dl>
        <p>El crédito, si lo tienes, aparece aparte: no es saldo propio.</p>
      </section>
      <section className="pb-panel" aria-labelledby="w-como">
        <h2 id="w-como">Qué puedes hacer</h2>
        <ol className="pb-steps">
          <li>
            <strong>Ingresar</strong>
            <p>Desde Movimientos → Ingresar.</p>
          </li>
          <li>
            <strong>Enviar</strong>
            <p>A otra persona del programa, con su correo.</p>
          </li>
          <li>
            <strong>Retirar</strong>
            <p>Hacia tu cuenta. Si el resultado queda en duda, lo verificamos antes de repetir.</p>
          </li>
        </ol>
        {terms ? (
          <p>
            Monedas del programa: <strong>{terms.currencies.join(', ')}</strong>.
          </p>
        ) : null}
        <p className="pb-note">
          En este entorno, ingresos y retiros pasan por un proveedor simulado: no mueven dinero
          real.
        </p>
        <div className="pb-actions">
          <Link className="pb-btn pb-btn-dark" href="/personal/movimientos?accion=ingresar">
            Ingresar saldo
          </Link>
        </div>
      </section>
    </div>
  );
}

function Card({ terms }: { terms: ProgramTerms | null }) {
  return (
    <div className="pb-cols">
      <section className="pb-panel" aria-labelledby="c-que">
        <h2 id="c-que">Una tarjeta virtual para comercios Fluvia</h2>
        <p>
          Pagas con tu saldo o, si eliges cuotas y tienes límite, con tu crédito. La tarjeta se paga
          en comercios de la red Fluvia.
        </p>
        <dl className="pb-facts">
          <div>
            <dt>Tarjetas activas a la vez</dt>
            <dd>{terms ? `hasta ${terms.cards.max_live}` : '—'}</dd>
          </div>
          <div>
            <dt>Límites por compra y por día</dt>
            <dd>los pones tú</dd>
          </div>
          <div>
            <dt>Bloquear y desbloquear</dt>
            <dd>al instante</dd>
          </div>
        </dl>
      </section>
      <section className="pb-panel" aria-labelledby="c-seg">
        <h2 id="c-seg">Seguridad</h2>
        <p>
          Fluvia nunca te pedirá el número completo de tu tarjeta, el código de seguridad, tu
          contraseña ni códigos de un solo uso por chat, llamada o foto.
        </p>
        <p className="pb-note">
          Emisión simulada en este entorno: la tarjeta no existe en ninguna red real.
        </p>
        <div className="pb-actions">
          <Link className="pb-btn pb-btn-dark" href="/personal/tarjetas">
            Pedir mi tarjeta
          </Link>
        </div>
      </section>
    </div>
  );
}

function Installments({ terms }: { terms: ProgramTerms }) {
  const p = terms.policy;
  return (
    <>
      <SyntheticNote terms={terms} />
      <div className="pb-cols" style={{ marginTop: 16 }}>
        <section className="pb-panel pb-panel-credit" aria-labelledby="i-cond">
          <h2 id="i-cond">Condiciones vigentes</h2>
          <dl className="pb-facts">
            <div>
              <dt>Número de cuotas</dt>
              <dd>{p.installment_counts.join(', ')}</dd>
            </div>
            <div>
              <dt>Cada cuánto</dt>
              <dd>{p.interval_days} días</dd>
            </div>
            <div>
              <dt>Pago inicial</dt>
              <dd>{pct(p.down_payment_bps)} del total</dd>
            </div>
            <div>
              <dt>Interés</dt>
              <dd>{pct(p.interest_bps)}</dd>
            </div>
            <div>
              <dt>Recargo por atraso</dt>
              <dd>{pct(p.late_fee_bps)}</dd>
            </div>
            <div>
              <dt>Días de gracia</dt>
              <dd>{p.grace_days}</dd>
            </div>
          </dl>
        </section>
        <section className="pb-panel" aria-labelledby="i-lim">
          <h2 id="i-lim">Tu límite</h2>
          <p>
            El límite se calcula con la garantía que bloqueas y tu historial en Fluvia, hasta{' '}
            {(p.max_multiplier_bps / 10_000).toLocaleString('es-VE')} veces la garantía. No está
            garantizado: puede rechazarse o pasar a revisión.
          </p>
          <dl className="pb-facts">
            {Object.entries(p.limits).map(([ccy, l]) => (
              <div key={ccy}>
                <dt>{ccy}: garantía mínima · límite máximo</dt>
                <dd>
                  {money(l.min_collateral, ccy)} · {money(l.max_limit, ccy)}
                </dd>
              </div>
            ))}
          </dl>
          <p>El crédito no es saldo propio: siempre se muestra aparte.</p>
          <div className="pb-actions">
            <Link className="pb-btn pb-btn-dark" href="/personal/credito">
              Solicitar un límite
            </Link>
          </div>
        </section>
      </div>
    </>
  );
}
