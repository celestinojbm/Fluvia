'use client';

import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { FluviaLogo } from './brand';
import { Icon, type IconName } from './icons';
import { AssistantRoot, AssistantTrigger } from './assistant/assistant';

/**
 * Estructura común de la plataforma del comercio: barra lateral en escritorio
 * (≥ 1024 px) y barra superior con cajón de navegación en tablet/móvil.
 *
 *  - «Saltar al contenido» como primer elemento enfocable.
 *  - El cajón se abre con un botón (aria-expanded/aria-controls), se cierra con
 *    Escape, al navegar o al pulsar fuera; el foco vuelve al botón.
 *  - `aria-current="page"` marca la sección activa (prefijo de ruta).
 *  - Los permisos que se muestran son una PISTA de UX: el API decide (403).
 */

export interface ShellNavItem {
  href: string;
  label: string;
  icon: IconName;
  /** Coincidencia exacta (Inicio) en vez de por prefijo. */
  exact?: boolean;
  tag?: string;
}

export interface ShellNavSection {
  title: string;
  items: ShellNavItem[];
}

/** Lo mínimo del perfil de negocio que decide la navegación (pista de UX). */
export interface NavProfile {
  businessType: 'retail' | 'restaurant' | 'quick_service' | 'services';
  modules: string[];
  role: string;
}

export function orgNav(orgId: string, profile?: NavProfile): ShellNavSection[] {
  const o = `/o/${orgId}`;
  const mods = new Set(profile?.modules ?? []);
  const type = profile?.businessType ?? 'retail';
  const venue = mods.has('tables') || mods.has('kitchen');
  // Personal del local: solo sus pantallas de trabajo (el API decide igual).
  if (profile?.role === 'staff') {
    return [
      {
        title: 'Trabajo',
        items: [
          ...(mods.has('tables') || type === 'quick_service'
            ? [{ href: `${o}/sala`, label: 'Sala', icon: 'list' as const }]
            : []),
          ...(mods.has('kitchen')
            ? [{ href: `${o}/cocina`, label: 'Cocina', icon: 'flag' as const }]
            : []),
          ...(mods.has('in_person')
            ? [{ href: `${o}/cobrar`, label: 'Cobrar', icon: 'wallet' as const }]
            : []),
        ],
      },
    ];
  }
  if (type === 'services') {
    return [
      {
        title: 'Cobrar',
        items: [
          { href: o, label: 'Inicio', icon: 'home', exact: true },
          { href: `${o}/cobrar`, label: 'Cobrar', icon: 'wallet' },
        ],
      },
      {
        title: 'Mis cobros',
        items: [
          { href: `${o}/payments`, label: 'Pagos', icon: 'card' },
          { href: `${o}/refunds`, label: 'Devoluciones', icon: 'undo' },
          { href: `${o}/por-confirmar`, label: 'Por confirmar', icon: 'clock' },
        ],
      },
      {
        title: 'Cuenta',
        items: [
          { href: `${o}/negocio`, label: 'Negocio', icon: 'gear' },
          { href: `${o}/settings`, label: 'Configuración', icon: 'tools' },
        ],
      },
    ];
  }
  return [
    {
      title: 'Vender',
      items: [
        { href: o, label: 'Inicio', icon: 'home', exact: true },
        ...(venue ? [{ href: `${o}/sala`, label: 'Sala', icon: 'list' as const }] : []),
        ...(mods.has('kitchen')
          ? [{ href: `${o}/cocina`, label: 'Cocina', icon: 'flag' as const }]
          : []),
        { href: `${o}/pos`, label: venue ? 'Caja' : 'Cobrar', icon: 'terminal' },
        ...(mods.has('in_person')
          ? [{ href: `${o}/cobrar`, label: 'Cobro presencial', icon: 'wallet' as const }]
          : []),
      ],
    },
    {
      title: 'Negocio',
      items: [
        { href: `${o}/orders`, label: 'Ventas', icon: 'receipt' },
        { href: `${o}/catalog`, label: 'Catálogo', icon: 'box' },
        { href: `${o}/customers`, label: 'Clientes', icon: 'users' },
        { href: `${o}/cash`, label: 'Caja', icon: 'cash' },
        { href: `${o}/installments`, label: 'Cuotas', icon: 'calendar', tag: 'Simulación' },
      ],
    },
    {
      title: 'Pagos',
      items: [
        { href: `${o}/payments`, label: 'Pagos', icon: 'card' },
        { href: `${o}/refunds`, label: 'Devoluciones', icon: 'undo' },
        { href: `${o}/por-confirmar`, label: 'Por confirmar', icon: 'clock' },
      ],
    },
    {
      title: 'Cuenta',
      items: [
        { href: `${o}/negocio`, label: 'Negocio', icon: 'layers' },
        { href: `${o}/team`, label: 'Equipo', icon: 'team' },
        { href: `${o}/directorio`, label: 'Directorio', icon: 'pin' },
        { href: `${o}/settings`, label: 'Configuración', icon: 'gear' },
        { href: `${o}/activity`, label: 'Operación avanzada', icon: 'tools' },
      ],
    },
  ];
}

function isActive(pathname: string, item: ShellNavItem): boolean {
  if (item.exact) return pathname === item.href;
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

export function AppShell({
  orgId,
  orgName,
  roleLabel,
  userEmail,
  profile,
  children,
}: {
  orgId: string;
  orgName: string;
  roleLabel: string;
  userEmail: string | null;
  profile?: NavProfile;
  children: ReactNode;
}) {
  const pathname = usePathname() ?? '';
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const sideRef = useRef<HTMLElement>(null);
  const sections = orgNav(orgId, profile);

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) btnRef.current?.focus();
  }, []);

  // Cerrar al navegar.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(true);
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (sideRef.current && !sideRef.current.contains(t) && !btnRef.current?.contains(t)) {
        close(false);
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    sideRef.current?.querySelector<HTMLElement>('a[href]')?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open, close]);

  return (
    <AssistantRoot base={`/api/assistant/o/${orgId}`} surface="commerce">
      <div className="app-shell">
        <a className="fx-skip" href="#fx-main">
          Saltar al contenido
        </a>
        <div className="fx-top">
          <button
            ref={btnRef}
            type="button"
            className="fx-menu-btn"
            aria-expanded={open}
            aria-controls="fx-side"
            onClick={() => setOpen((v) => !v)}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2" />
            </svg>
            <span className="sr-only">{open ? 'Cerrar menú' : 'Abrir menú'}</span>
          </button>
          <a className="fx-brand" href={`/o/${orgId}`}>
            <FluviaLogo height={22} />
          </a>
          <span className="fx-top-org">{orgName}</span>
          <AssistantTrigger className="as-trigger as-trigger-icon" compact />
        </div>

        <nav
          id="fx-side"
          ref={sideRef}
          className="fx-side"
          data-open={open ? 'true' : 'false'}
          aria-label="Navegación principal"
        >
          <a className="fx-brand" href={`/o/${orgId}`}>
            <FluviaLogo height={26} />
          </a>
          <div className="fx-org">
            <span className="fx-org-avatar" aria-hidden="true">
              {(orgName.trim()[0] ?? 'F').toUpperCase()}
            </span>
            <div>
              <strong>{orgName}</strong>
              <span>Comercio · {roleLabel}</span>
            </div>
          </div>
          {/* Acción principal según el negocio: el personal no vende por su
              cuenta y el independiente cobra (no crea ventas de catálogo). */}
          {profile?.role === 'staff' ? null : profile?.businessType === 'services' ? (
            <a
              className="fx-btn fx-btn-primary fx-btn-block fx-side-cta"
              href={`/o/${orgId}/cobrar`}
              aria-current={pathname.startsWith(`/o/${orgId}/cobrar`) ? 'page' : undefined}
            >
              <Icon name="wallet" />
              Cobrar
            </a>
          ) : (
            <a
              className="fx-btn fx-btn-primary fx-btn-block fx-side-cta"
              href={`/o/${orgId}/sell`}
              aria-current={pathname.startsWith(`/o/${orgId}/sell`) ? 'page' : undefined}
            >
              <Icon name="plus" />
              Nueva venta
            </a>
          )}
          <div className="fx-nav">
            {sections.map((s) => (
              <section key={s.title} aria-labelledby={`nav-${s.title}`}>
                <h2 id={`nav-${s.title}`}>{s.title}</h2>
                <ul>
                  {s.items.map((item) => (
                    <li key={item.href}>
                      <a
                        href={item.href}
                        aria-current={isActive(pathname, item) ? 'page' : undefined}
                      >
                        <Icon name={item.icon} />
                        <span>{item.label}</span>
                        {item.tag ? <span className="fx-tag">{item.tag}</span> : null}
                      </a>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
          <AssistantTrigger />
          <div className="fx-side-foot">
            {userEmail ? <p>{userEmail}</p> : null}
            <p>
              <a href="/">Cambiar de organización</a>
            </p>
            <a href="/logout">Cerrar sesión</a>
          </div>
        </nav>

        {/* Cada página aporta su propio <main> (un único landmark principal). */}
        <div id="fx-main" className="fx-main" tabIndex={-1}>
          {children}
        </div>
      </div>
    </AssistantRoot>
  );
}
