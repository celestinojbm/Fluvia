'use client';

import { usePathname } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { FluviaLogo } from '../../lib/brand';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../../lib/csrf-header';
import { Icon, type IconName } from '../../lib/icons';

/**
 * Estructura de Fluvia Personal: riel lateral (≥ 1024 px) y barra de pestañas
 * inferior (móvil/tablet). Pestañas principales: Inicio, Movimientos, Tarjetas,
 * Cuotas y Más (Crédito, Perfil). `aria-current` marca la sección activa.
 */
const NAV: { href: string; label: string; icon: IconName; exact?: boolean; tab: boolean }[] = [
  { href: '/personal', label: 'Inicio', icon: 'home', exact: true, tab: true },
  { href: '/personal/movimientos', label: 'Movimientos', icon: 'list', tab: true },
  { href: '/personal/tarjetas', label: 'Tarjetas', icon: 'card', tab: true },
  { href: '/personal/cuotas', label: 'Cuotas', icon: 'calendar', tab: true },
  { href: '/personal/credito', label: 'Crédito y garantía', icon: 'shield', tab: false },
  { href: '/personal/perfil', label: 'Perfil y ayuda', icon: 'user', tab: false },
];

function active(path: string, href: string, exact?: boolean) {
  return exact ? path === href : path === href || path.startsWith(`${href}/`);
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
  const moreActive = NAV.filter((n) => !n.tab).some((n) => active(path, n.href));
  return (
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
              <a href={n.href} aria-current={active(path, n.href, n.exact) ? 'page' : undefined}>
                <Icon name={n.icon} />
                <span>{n.label}</span>
              </a>
            </li>
          ))}
        </ul>
        <div className="px-rail-foot">
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
        <a className="px-top-user" href="/personal/perfil" aria-label="Perfil y ayuda">
          <span aria-hidden="true">{(name.trim()[0] ?? 'F').toUpperCase()}</span>
        </a>
      </header>
      <div id="px-main" className="px-main" tabIndex={-1}>
        {children}
        <p className="px-sandbox-note">
          Entorno de prueba: datos sintéticos, proveedores simulados y sin dinero real. Fluvia no es
          un banco ni emisor; las condiciones mostradas son de prueba y están pendientes de
          validación comercial.
        </p>
      </div>
      <nav className="px-tabs" aria-label="Secciones">
        <ul>
          {NAV.filter((n) => n.tab).map((n) => (
            <li key={n.href}>
              <a href={n.href} aria-current={active(path, n.href, n.exact) ? 'page' : undefined}>
                <Icon name={n.icon} size={22} />
                <span>{n.label}</span>
              </a>
            </li>
          ))}
          <li>
            <a href="/personal/perfil" aria-current={moreActive ? 'page' : undefined}>
              <Icon name="user" size={22} />
              <span>Más</span>
            </a>
          </li>
        </ul>
      </nav>
    </div>
  );
}
