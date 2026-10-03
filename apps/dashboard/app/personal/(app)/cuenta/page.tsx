import { Icon, type IconName } from '../../../lib/icons';
import { ErrorPanel } from '../../lib/panels';
import { readPersonal } from '../../lib/server';
import { HideAmountsSwitch } from '../../lib/hide-amounts';
import { ScreenHead, initial } from '../../lib/shop-ui';
import type { Me } from '../../lib/types';
import { LogoutButton } from '../perfil/logout';

export const dynamic = 'force-dynamic';

function Row({
  href,
  icon,
  title,
  sub,
}: {
  href: string;
  icon: IconName;
  title: string;
  sub: string;
}) {
  return (
    <li>
      <a className="pm-row" href={href}>
        <span className="pm-row-ico" aria-hidden="true">
          <Icon name={icon} />
        </span>
        <span className="pm-row-body">
          <p className="pm-row-title">{title}</p>
          <p className="pm-row-sub">{sub}</p>
        </span>
        <Icon name="chevron-right" />
      </a>
    </li>
  );
}

/**
 * Cuenta: perfil, accesos a tu dinero (tarjetas, wallet, crédito, cuotas),
 * seguridad, preferencias de ESTE dispositivo y conexiones. Nada simula
 * guardar cambios que no existen.
 */
export default async function CuentaPage() {
  const me = await readPersonal<Me>('/me');
  if (me.kind !== 'ok') return <ErrorPanel />;
  const c = me.data.consumer;
  return (
    <main aria-labelledby="pm-account-title">
      <ScreenHead title="Cuenta" id="pm-account-title" />
      <section
        className="pm-card"
        style={{ display: 'flex', gap: 14, alignItems: 'center' }}
        aria-label="Perfil"
      >
        <span
          className="pm-shop-mark"
          aria-hidden="true"
          style={{ position: 'static', boxShadow: 'none', width: 56, height: 56 }}
        >
          {initial(c.display_name)}
        </span>
        <div style={{ minWidth: 0 }}>
          <p style={{ margin: 0, fontWeight: 800, fontSize: '1.125rem' }}>{c.display_name}</p>
          <p className="pm-muted" style={{ margin: 0, overflowWrap: 'anywhere' }}>
            {c.email}
          </p>
          <div className="pm-tags" style={{ marginTop: 6 }}>
            <span className="pm-tag">
              {c.status === 'active' ? 'Cuenta activa' : 'Cuenta suspendida'}
            </span>
            {me.data.program.sandbox ? (
              <span className="pm-tag is-sim">Programa de prueba</span>
            ) : null}
          </div>
        </div>
      </section>

      <h2 className="pm-group-label">Tu dinero</h2>
      <ul className="pm-list">
        <Row
          href="/personal/tarjetas"
          icon="card"
          title="Tarjetas"
          sub="Virtual y física, bloqueo, límites y pago en comercios"
        />
        <Row
          href="/personal/movimientos"
          icon="wallet"
          title="Wallet"
          sub="Ingresar, enviar, retirar y extracto del saldo"
        />
        <Row
          href="/personal/credito"
          icon="shield"
          title="Crédito y garantía"
          sub="Límite, garantía bloqueada y solicitudes"
        />
        <Row
          href="/personal/cuotas"
          icon="calendar"
          title="Cuotas"
          sub="Calendario y pagos de tus compras en cuotas"
        />
      </ul>

      <h2 className="pm-group-label">Seguridad</h2>
      <ul className="pm-list">
        <li>
          <div className="pm-row">
            <span className="pm-row-ico" aria-hidden="true">
              <Icon name="lock" />
            </span>
            <span className="pm-row-body">
              <p className="pm-row-title">Sesión en este dispositivo</p>
              <p className="pm-row-sub">
                Caduca a las 12 horas. Tras varios intentos fallidos, la cuenta se bloquea unos
                minutos.
              </p>
            </span>
            <LogoutButton />
          </div>
        </li>
        <Row
          href="/personal/tarjetas"
          icon="ban"
          title="¿Perdiste tu tarjeta?"
          sub="Bloquéala al instante y pide otra"
        />
      </ul>
      <p className="pm-muted" style={{ margin: '8px 4px 0' }}>
        La lista de sesiones y dispositivos todavía no está disponible.
      </p>

      <h2 className="pm-group-label">Preferencias</h2>
      <HideAmountsSwitch />

      <h2 className="pm-group-label">Conexiones</h2>
      <div className="pm-card">
        <p style={{ margin: 0 }}>
          No tienes conexiones externas. Fluvia no se conecta a bancos ni a tiendas en tu nombre en
          este entorno.
        </p>
      </div>

      <h2 className="pm-group-label">Ayuda</h2>
      <ul className="pm-list">
        <Row
          href="/personal/perfil"
          icon="help"
          title="Perfil y ayuda"
          sub="Preguntas frecuentes y soporte"
        />
      </ul>
    </main>
  );
}
