import { Icon } from '../../../lib/icons';
import { ErrorPanel } from '../../lib/panels';
import { readPersonal } from '../../lib/server';
import type { Me } from '../../lib/types';
import { LogoutButton } from './logout';

export const dynamic = 'force-dynamic';

export default async function Perfil() {
  const me = await readPersonal<Me>('/me');
  if (me.kind !== 'ok') return <ErrorPanel />;
  const c = me.data.consumer;
  return (
    <main aria-labelledby="px-profile">
      <div className="px-head">
        <div>
          <p className="px-eyebrow">Perfil</p>
          <h1 id="px-profile">{c.display_name}</h1>
        </div>
      </div>
      <ul className="px-list">
        <li>
          <span className="px-icon-chip" aria-hidden="true">
            <Icon name="user" />
          </span>
          <div className="px-grow">
            <p className="px-title">{c.email}</p>
            <p className="px-sub">
              Cuenta {c.status === 'active' ? 'activa' : 'suspendida'} · programa{' '}
              {me.data.program.name}
            </p>
          </div>
        </li>
        <li>
          <span className="px-icon-chip" aria-hidden="true">
            <Icon name="shield" />
          </span>
          <div className="px-grow">
            <p className="px-title">Crédito y garantía</p>
            <p className="px-sub">Límite, garantía bloqueada y solicitudes</p>
          </div>
          <a href="/personal/credito">Abrir</a>
        </li>
      </ul>

      <section className="px-section" aria-labelledby="px-sec">
        <h2 id="px-sec">Seguridad</h2>
        <ul className="px-list">
          <li>
            <span className="px-icon-chip" aria-hidden="true">
              <Icon name="lock" />
            </span>
            <div className="px-grow">
              <p className="px-title">Sesión</p>
              <p className="px-sub">
                Las sesiones caducan a las 12 horas y tras varios intentos fallidos la cuenta se
                bloquea unos minutos.
              </p>
            </div>
            <LogoutButton />
          </li>
          <li>
            <span className="px-icon-chip" aria-hidden="true">
              <Icon name="card" />
            </span>
            <div className="px-grow">
              <p className="px-title">¿Perdiste tu tarjeta?</p>
              <p className="px-sub">Bloquéala al instante y pide una nueva desde Tarjetas.</p>
            </div>
            <a href="/personal/tarjetas">Ir</a>
          </li>
        </ul>
      </section>

      <section className="px-section" aria-labelledby="px-help">
        <h2 id="px-help">Ayuda</h2>
        <div className="px-card">
          <p style={{ marginTop: 0 }}>
            <strong>Soporte (entorno de prueba)</strong>: escribe a soporte con tu correo y la
            referencia del movimiento. El equipo de Operaciones abre un caso y te responde con su
            seguimiento.
          </p>
          <details>
            <summary>¿Qué diferencia hay entre saldo, garantía y crédito?</summary>
            <p>
              Tu <strong>saldo</strong> y tu <strong>garantía</strong> son dinero tuyo; la garantía
              está bloqueada para respaldar tu crédito y puedes liberar la parte que no lo respalde.
              El <strong>crédito</strong> no es dinero tuyo: lo que usas se devuelve en cuotas.
            </p>
          </details>
          <details>
            <summary>¿Qué pasa si una operación queda «confirmando»?</summary>
            <p>
              Si el banco o el comercio no responden, retenemos el importe hasta tener la
              confirmación verificada. No repitas la operación: se resolverá sola o la revisará una
              persona.
            </p>
          </details>
        </div>
      </section>
    </main>
  );
}
