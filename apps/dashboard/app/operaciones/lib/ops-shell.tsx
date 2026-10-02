'use client';

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { FluviaLogo } from '../../lib/brand';
import { Icon, type IconName } from '../../lib/icons';

/**
 * Fluvia Operaciones — «Sala de control»: barra superior oscura con programa,
 * buscador de clientes y operador; navegación lateral clara y compacta.
 */
export function OpsShell({
  orgId,
  programName,
  role,
  queues,
  children,
}: {
  orgId: string;
  programName: string;
  role: string;
  queues: { cases: number; reviews: number; uncertain: number };
  children: ReactNode;
}) {
  const path = usePathname() ?? '';
  const base = `/operaciones/${orgId}`;
  const nav: { href: string; label: string; icon: IconName; exact?: boolean; badge?: number }[] = [
    { href: base, label: 'Resumen', icon: 'home', exact: true },
    { href: `${base}/clientes`, label: 'Clientes', icon: 'users' },
    {
      href: `${base}/solicitudes`,
      label: 'Solicitudes y límites',
      icon: 'shield',
      badge: queues.reviews,
    },
    { href: `${base}/tarjetas`, label: 'Tarjetas', icon: 'card' },
    { href: `${base}/transacciones`, label: 'Transacciones', icon: 'receipt' },
    { href: `${base}/casos`, label: 'Casos e inciertos', icon: 'flag', badge: queues.cases },
    { href: `${base}/eventos`, label: 'Eventos y conciliación', icon: 'refresh' },
    { href: `${base}/politica`, label: 'Política y aprobaciones', icon: 'layers' },
  ];
  const isActive = (h: string, exact?: boolean) =>
    exact ? path === h : path === h || path.startsWith(`${h}/`);
  return (
    <div className="ox-shell">
      <a className="fx-skip" href="#ox-main">
        Saltar al contenido
      </a>
      <header className="ox-top">
        <a className="ox-brand" href={base}>
          <FluviaLogo height={20} label="Operaciones" />
        </a>
        <span className="ox-program">{programName}</span>
        <form className="ox-search" action={`${base}/clientes`} role="search">
          <label htmlFor="ox-q" className="sr-only">
            Buscar cliente
          </label>
          <Icon name="search" />
          <input id="ox-q" name="q" placeholder="Buscar cliente por correo, nombre o id" />
        </form>
        <span className="ox-role">{role}</span>
      </header>
      <nav className="ox-nav" aria-label="Operaciones">
        <ul>
          {nav.map((n) => (
            <li key={n.href}>
              <a href={n.href} aria-current={isActive(n.href, n.exact) ? 'page' : undefined}>
                <Icon name={n.icon} />
                <span>{n.label}</span>
                {n.badge ? (
                  <span className="ox-badge" aria-label={`${n.badge} pendientes`}>
                    {n.badge}
                  </span>
                ) : null}
              </a>
            </li>
          ))}
        </ul>
        <p className="ox-nav-foot">
          <a href="/">Mis organizaciones</a> · <a href="/logout">Salir</a>
        </p>
      </nav>
      <div id="ox-main" className="ox-main" tabIndex={-1}>
        {children}
      </div>
    </div>
  );
}
