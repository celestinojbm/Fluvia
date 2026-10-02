import Link from 'next/link';
import { Icon } from '../../lib/icons';
import { PublicShell } from '../../lib/public-shell';

export const metadata = { title: 'Ayuda · Fluvia' };

/**
 * Centro de ayuda: guías breves enlazadas a la pantalla real de cada paso. El
 * asistente vive DENTRO de Personal y Comercio (necesita saber quién eres para
 * leer tus datos con permiso); aquí se explica cómo llegar a él.
 */
const PERSONAL: Array<{ q: string; steps: string[]; link: { href: string; label: string } }> = [
  {
    q: 'Cómo ingresar saldo',
    steps: ['Entra a Personal.', 'Ve a Movimientos → Ingresar.', 'Indica el importe y confirma.'],
    link: { href: '/personal/movimientos?accion=ingresar', label: 'Ir a Ingresar' },
  },
  {
    q: 'Cómo pedir y bloquear la tarjeta',
    steps: [
      'Ve a Tarjetas → Pedir una tarjeta.',
      'Actívala cuando llegue a «Por activar».',
      'Para bloquearla, pulsa «Bloquear» en la misma pantalla.',
    ],
    link: { href: '/personal/tarjetas', label: 'Ir a Tarjetas' },
  },
  {
    q: 'Cómo solicitar un límite para cuotas',
    steps: [
      'Bloquea una garantía desde tu saldo.',
      'Ve a Crédito y envía la solicitud.',
      'Revisa el resultado: puede aprobarse, rechazarse o pasar a revisión.',
    ],
    link: { href: '/personal/credito', label: 'Ir a Crédito' },
  },
  {
    q: 'Cómo pagar una cuota',
    steps: [
      'Ve a Cuotas → «Pagar cuotas».',
      'Elige el plan en «Aplicar a» y el importe.',
      'Confirma: el pago sale de tu saldo propio.',
    ],
    link: { href: '/personal/cuotas', label: 'Ir a Cuotas' },
  },
  {
    q: 'Un pago quedó «en verificación»',
    steps: [
      'No vuelvas a pagar: el resultado se está confirmando.',
      'Fluvia lo verifica con el proveedor de forma automática.',
      'Revisa el estado en Movimientos en unos minutos.',
    ],
    link: { href: '/personal/movimientos', label: 'Ir a Movimientos' },
  },
];

const COMERCIO: Array<{ q: string; steps: string[]; link: { href: string; label: string } }> = [
  {
    q: 'Cómo cobrar en mostrador',
    steps: [
      'Entra al panel.',
      'Pulsa «Nueva venta» o «Cobrar».',
      'Muestra el código o el enlace al cliente.',
    ],
    link: { href: '/login', label: 'Entrar al panel' },
  },
  {
    q: 'Un cobro quedó incierto',
    steps: [
      'No cobres otra vez: el resultado puede llegar tarde.',
      'Abre «Por confirmar» y verifica el pago.',
      'Solo cuando el estado sea definitivo, decide si cobras de nuevo.',
    ],
    link: { href: '/login', label: 'Entrar al panel' },
  },
  {
    q: 'Cómo publicar mi perfil en «Dónde comprar»',
    steps: [
      'En el panel, abre «Directorio» (menú Cuenta).',
      'Completa nombre, categoría y ciudad.',
      'Pulsa «Publicar» y confirma. Puedes retirarlo cuando quieras.',
    ],
    link: { href: '/login', label: 'Entrar al panel' },
  },
];

function Guides({ items }: { items: typeof PERSONAL }) {
  return (
    <div className="pb-guides">
      {items.map((g) => (
        <details key={g.q} className="pb-guide">
          <summary>{g.q}</summary>
          <div>
            <ol>
              {g.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
            <Link className="pb-more" href={g.link.href}>
              {g.link.label} <Icon name="arrow-right" size={16} />
            </Link>
          </div>
        </details>
      ))}
    </div>
  );
}

export default function HelpPage() {
  return (
    <PublicShell current="/ayuda">
      <div className="pb-page-head">
        <h1>Centro de ayuda</h1>
        <p>Guías cortas, con el enlace a la pantalla donde se hace cada paso.</p>
      </div>

      <section className="pb-sec" aria-labelledby="asistente">
        <div className="pb-panel pb-panel-dark">
          <h2 id="asistente">
            <Icon name="ai" /> Asistente Fluvia
          </h2>
          <p>
            Dentro de Personal y de Comercio, el asistente responde con tus datos y te lleva a la
            pantalla correcta. Es una IA: no aprueba créditos, no mueve dinero ni confirma pagos.
          </p>
          <div className="pb-actions">
            <Link className="pb-btn pb-btn-lime" href="/personal/entrar">
              Abrir en Personal
            </Link>
            <Link className="pb-btn pb-btn-on-dark" href="/login">
              Abrir en Comercio
            </Link>
          </div>
        </div>
      </section>

      <div className="pb-cols">
        <section aria-labelledby="h-personal">
          <h2 id="h-personal">Personal</h2>
          <Guides items={PERSONAL} />
        </section>
        <section aria-labelledby="h-comercio">
          <h2 id="h-comercio">Comercio</h2>
          <Guides items={COMERCIO} />
        </section>
      </div>

      <section className="pb-sec" aria-labelledby="seguridad">
        <div className="pb-state">
          <h2 id="seguridad">Seguridad</h2>
          <p>
            Nadie de Fluvia te pedirá el número completo de tu tarjeta, el código de seguridad, tu
            contraseña ni códigos de un solo uso. No los envíes por chat, llamada ni foto.
          </p>
        </div>
      </section>
    </PublicShell>
  );
}
