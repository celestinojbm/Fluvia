import Link from 'next/link';
import { PublicShell } from '../../lib/public-shell';

export const metadata = { title: 'Para comercios · Fluvia' };

/**
 * Entrada de comercios. Describe herramientas que existen en el panel; no
 * promete liquidación, comisiones ni condiciones comerciales (sin decidir).
 */
export default function MerchantsPage() {
  return (
    <PublicShell current="/comercios">
      <div className="pb-page-head">
        <h1>Para comercios</h1>
        <p>Un panel para vender, cobrar y conciliar. Este entorno usa dinero simulado.</p>
      </div>
      <div className="pb-cols pb-cols-3" style={{ marginTop: 16 }}>
        <article className="pb-panel">
          <h2>Cobrar</h2>
          <p>Terminal en mostrador, enlaces de pago y venta desde el catálogo con justificante.</p>
        </article>
        <article className="pb-panel">
          <h2>Gestionar</h2>
          <p>Catálogo con existencias, clientes, devoluciones, cuotas y conciliación.</p>
        </article>
        <article className="pb-panel">
          <h2>Aparecer en el directorio</h2>
          <p>
            Tú decides si publicas tu perfil en «Dónde comprar», con qué datos, y cuándo retirarlo.
          </p>
        </article>
      </div>
      <section className="pb-sec" aria-labelledby="pendiente">
        <div className="pb-state">
          <h2 id="pendiente">Lo que aún no ofrecemos</h2>
          <p>
            Liquidación a tu cuenta bancaria, comisiones y condiciones comerciales no están
            definidas en este entorno. No las asumas a partir de esta demostración.
          </p>
        </div>
      </section>
      <div className="pb-actions">
        <Link className="pb-btn pb-btn-lime" href="/signup">
          Registrar mi comercio
        </Link>
        <Link className="pb-btn pb-btn-dark" href="/login">
          Ya tengo cuenta
        </Link>
      </div>
    </PublicShell>
  );
}
