'use client';

import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

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

type IconName =
  | 'home'
  | 'cart'
  | 'terminal'
  | 'receipt'
  | 'box'
  | 'users'
  | 'cash'
  | 'calendar'
  | 'card'
  | 'undo'
  | 'team'
  | 'gear'
  | 'tools';

const ICON_PATHS: Record<IconName, string> = {
  home: 'M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z',
  cart: 'M3 4h2l2.4 11h11L21 7H6.2M9 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2Zm9 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z',
  terminal: 'M5 3h14v18H5zM8 7h8M8 11h8M9 15h2m2 0h2M9 18h6',
  receipt: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6',
  box: 'M3 7.5 12 3l9 4.5v9L12 21l-9-4.5zM3 7.5 12 12l9-4.5M12 12v9',
  users:
    'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 10a7 7 0 0 1 14 0M17 3.5a4 4 0 0 1 0 7.5M22 21a7 7 0 0 0-4-6.3',
  cash: 'M2 6h20v12H2zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 9v6m12-6v6',
  calendar: 'M4 5h16v16H4zM4 9h16M8 3v4m8-4v4M8 13h2m4 0h2M8 17h2',
  card: 'M2 5h20v14H2zM2 10h20M6 15h4',
  undo: 'M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3',
  team: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-8 9a8 8 0 0 1 16 0',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.3l2-1.6-2-3.4-2.4 1a7.5 7.5 0 0 0-2.2-1.3L14.4 2h-4l-.4 2.4a7.5 7.5 0 0 0-2.2 1.3l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.6l-2 1.6 2 3.4 2.4-1a7.5 7.5 0 0 0 2.2 1.3l.4 2.4h4l.4-2.4a7.5 7.5 0 0 0 2.2-1.3l2.4 1 2-3.4-2-1.6c.1-.4.1-.9.1-1.3Z',
  tools: 'M14 6a4 4 0 0 0 5 5l-9 9a2 2 0 0 1-3-3l9-9a4 4 0 0 0-2-2Z',
};

function Icon({ name }: { name: IconName }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

export function FluviaMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="8" fill="#f4ead7" />
      <path
        d="M6 12c3.3-2.7 6.7-2.7 10 0s6.7 2.7 10 0M6 18c3.3-2.7 6.7-2.7 10 0s6.7 2.7 10 0M6 24c3.3-2.7 6.7-2.7 10 0"
        fill="none"
        stroke="#0a6470"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function orgNav(orgId: string): ShellNavSection[] {
  const o = `/o/${orgId}`;
  return [
    {
      title: 'Vender',
      items: [
        { href: o, label: 'Inicio', icon: 'home', exact: true },
        { href: `${o}/sell`, label: 'Nueva venta', icon: 'cart' },
        { href: `${o}/pos`, label: 'Cobrar (terminal)', icon: 'terminal' },
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
      ],
    },
    {
      title: 'Cuenta',
      items: [
        { href: `${o}/team`, label: 'Equipo', icon: 'team' },
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
  children,
}: {
  orgId: string;
  orgName: string;
  roleLabel: string;
  userEmail: string | null;
  children: ReactNode;
}) {
  const pathname = usePathname() ?? '';
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const sideRef = useRef<HTMLElement>(null);
  const sections = orgNav(orgId);

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
          <FluviaMark size={26} />
          <span className="fx-brand-word">Fluvia</span>
        </a>
        <span className="fx-top-org">{orgName}</span>
      </div>

      <nav
        id="fx-side"
        ref={sideRef}
        className="fx-side"
        data-open={open ? 'true' : 'false'}
        aria-label="Navegación principal"
      >
        <a className="fx-brand" href={`/o/${orgId}`}>
          <FluviaMark />
          <span className="fx-brand-word">Fluvia</span>
        </a>
        <div className="fx-org">
          <strong>{orgName}</strong>
          <span>Comercio · {roleLabel}</span>
        </div>
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
  );
}
