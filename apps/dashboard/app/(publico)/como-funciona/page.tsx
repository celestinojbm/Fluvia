import Link from 'next/link';
import { PublicShell } from '../../lib/public-shell';

export const metadata = { title: 'Cómo funciona · Fluvia' };

/** Pasos reales, cada uno enlazado a la pantalla donde se hace. */
export default function HowItWorksPage() {
  return (
    <PublicShell current="/como-funciona">
      <div className="pb-page-head">
        <h1>Cómo funciona</h1>
        <p>Dos caminos: el de quien compra y el de quien vende.</p>
      </div>
      <div className="pb-cols" style={{ marginTop: 16 }}>
        <section className="pb-panel" aria-labelledby="personas">
          <h2 id="personas">Si compras</h2>
          <ol className="pb-steps">
            <li>
              <strong>Crea tu cuenta Personal</strong>
              <p>
                En <Link href="/personal/entrar">Entrar a Personal</Link>, con tu correo y una
                contraseña.
              </p>
            </li>
            <li>
              <strong>Ingresa saldo</strong>
              <p>
                Desde{' '}
                <Link href="/personal/movimientos?accion=ingresar">Movimientos → Ingresar</Link>.
              </p>
            </li>
            <li>
              <strong>Pide tu tarjeta virtual</strong>
              <p>
                En <Link href="/personal/tarjetas">Tarjetas</Link>. Pones límites y la bloqueas
                cuando quieras.
              </p>
            </li>
            <li>
              <strong>Si quieres cuotas, solicita un límite</strong>
              <p>
                En <Link href="/personal/credito">Crédito</Link>: bloqueas una garantía y se evalúa.
                Ver <Link href="/conoce/cuotas">condiciones vigentes</Link>.
              </p>
            </li>
            <li>
              <strong>Paga en un comercio Fluvia</strong>
              <p>
                Búscalo en <Link href="/donde-comprar">Dónde comprar</Link>. Tus cuotas y pagos
                quedan en <Link href="/personal/cuotas">Cuotas</Link>.
              </p>
            </li>
          </ol>
        </section>
        <section className="pb-panel" aria-labelledby="comercios">
          <h2 id="comercios">Si vendes</h2>
          <ol className="pb-steps">
            <li>
              <strong>Registra tu comercio</strong>
              <p>
                En <Link href="/signup">Registrar comercio</Link> y completa la puesta en marcha.
              </p>
            </li>
            <li>
              <strong>Carga tu catálogo</strong>
              <p>Productos con precio, foto opcional y existencias.</p>
            </li>
            <li>
              <strong>Cobra</strong>
              <p>Con la terminal «Cobrar», con enlace de pago o con el código del cliente.</p>
            </li>
            <li>
              <strong>Publica tu perfil (opcional)</strong>
              <p>
                Solo si lo decides, aparece en <Link href="/donde-comprar">Dónde comprar</Link>.
                Puedes retirarlo cuando quieras.
              </p>
            </li>
          </ol>
        </section>
      </div>
    </PublicShell>
  );
}
