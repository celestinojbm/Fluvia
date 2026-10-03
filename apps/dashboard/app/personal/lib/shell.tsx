'use client';

import { usePathname } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { FluviaLogo } from '../../lib/brand';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../../lib/csrf-header';
import { Icon, type IconName } from '../../lib/icons';
import { AssistantRoot, AssistantTrigger } from '../../lib/assistant/assistant';
import { HideAmountsProvider } from './hide-amounts';
import { RatesStrip } from '../../lib/fx-ui';

/**
 * Estructura de Fluvia Personal: cinco destinos — Inicio · Tiendas · Pagar ·
 * Actividad · Cuenta — en la barra superior (≥ 1024 px) y en la barra inferior
 * (móvil/tablet, con safe areas). Tarjetas, wallet, garantía, crédito y cuotas
 * siguen a un toque desde Inicio y Cuenta; `match` marca como activo el
 * destino que las contiene. `aria-current` marca la sección activa.
 */
const NAV: { href: string; label: string; icon: IconName; exact?: boolean; match?: string[] }[] = [
  {
    href: '/personal',
    label: 'Inicio',
    icon: 'home',
    exact: true,
    match: ['/personal/tarjetas', '/personal/credito'],
  },
  {
    href: '/personal/tiendas',
    label: 'Tiendas',
    icon: 'bag',
    match: ['/personal/carrito', '/personal/pedidos'],
  },
  { href: '/personal/pagar', label: 'Pagar', icon: 'qr' },
  {
    href: '/personal/actividad',
    label: 'Actividad',
    icon: 'list',
    match: ['/personal/movimientos', '/personal/cuotas'],
  },
  { href: '/personal/cuenta', label: 'Cuenta', icon: 'user', match: ['/personal/perfil'] },
];

function active(path: string, n: (typeof NAV)[number]) {
  const own = n.exact ? path === n.href : path === n.href || path.startsWith(`${n.href}/`);
  return own || (n.match ?? []).some((m) => path === m || path.startsWith(`${m}/`));
}

export function PersonalShell({ name, children }: { name: string; children: ReactNode }) {
  const path = usePathname() ?? '';
  const [leaving, setLeaving] = useState(false);
  const logout = async () => {
    setLeaving(true);
    await fetch('/api/personal-session', {
      method: 'DELETE',
      headers: { [CSRF_HEADER]: CSRF_HEADER_VALUE },
    }).catch(() => undefined);
    window.location.href = '/personal/entrar';
  };
  return (
    <HideAmountsProvider>
      <AssistantRoot base="/api/assistant/personal" surface="personal">
        <div className="px-shell">
          <a className="fx-skip" href="#px-main">
            Saltar al contenido
          </a>
          <nav className="px-rail" aria-label="Fluvia Personal">
            <a className="px-brand" href="/personal">
              <FluviaLogo height={24} label="Personal" />
            </a>
            <ul>
              {NAV.map((n) => (
                <li key={n.href}>
                  <a href={n.href} aria-current={active(path, n) ? 'page' : undefined}>
                    <Icon name={n.icon} />
                    <span>{n.label}</span>
                  </a>
                </li>
              ))}
            </ul>
            <div className="px-rail-foot">
              <AssistantTrigger className="as-trigger as-trigger-icon" compact />
              <p>{name}</p>
              <button type="button" className="px-link" onClick={logout} disabled={leaving}>
                {leaving ? 'Cerrando…' : 'Cerrar sesión'}
              </button>
            </div>
          </nav>
          <header className="px-top">
            <a className="px-brand" href="/personal">
              <FluviaLogo height={22} label="Personal" />
            </a>
            <AssistantTrigger className="as-trigger as-trigger-icon" compact />
            <a className="px-top-user" href="/personal/cuenta" aria-label="Cuenta">
              <span aria-hidden="true">{(name.trim()[0] ?? 'F').toUpperCase()}</span>
            </a>
          </header>
          <div id="px-main" className="px-main" tabIndex={-1}>
            <RatesStrip />
            {children}
            <p className="px-sandbox-note">
              Entorno de prueba: datos sintéticos, proveedores simulados y sin dinero real. Fluvia
              no es un banco ni emisor; las condiciones mostradas son de prueba y están pendientes
              de validación comercial.
            </p>
          </div>
          <nav className="pm-tabs" aria-label="Secciones">
            <ul>
              {NAV.map((n) => (
                <li key={n.href}>
                  <a
                    href={n.href}
                    className={n.href === '/personal/pagar' ? 'pm-tab-pay' : undefined}
                    aria-current={active(path, n) ? 'page' : undefined}
                  >
                    <span className="pm-tab-ico">
                      <Icon name={n.icon} size={22} />
                    </span>
                    <span>{n.label}</span>
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </AssistantRoot>
    </HideAmountsProvider>
  );
}
