import type { ReactNode } from 'react';
import Link from 'next/link';
import { FluviaLogo } from './brand';
import { Icon } from './icons';
import '../publico.css';

/**
 * Armazón de la presentación PÚBLICA (A): portada, directorio, explicadores y
 * ayuda. Separado de Personal (B) y Comercio (C): aquí no hay datos de nadie.
 * La barra «SANDBOX» la pone el layout raíz una sola vez; esta página no
 * repite el aviso.
 */
const NAV: Array<{ href: string; label: string }> = [
  { href: '/#categorias', label: 'Explorar' },
  { href: '/donde-comprar', label: 'Dónde comprar' },
  { href: '/como-funciona', label: 'Cómo funciona' },
  { href: '/comercios', label: 'Para comercios' },
  { href: '/ayuda', label: 'Ayuda' },
];

export function PublicShell({ children, current }: { children: ReactNode; current?: string }) {
  return (
    <div className="pb">
      <a className="pb-skip" href="#pb-main">
        Saltar al contenido
      </a>
      <header className="pb-top">
        <Link href="/" className="pb-brand" aria-label="Fluvia, inicio">
          <FluviaLogo height={24} />
        </Link>
        <nav className="pb-nav" aria-label="Principal">
          <ul>
            {NAV.map((n) => (
              <li key={n.href}>
                <Link href={n.href} aria-current={current === n.href ? 'page' : undefined}>
                  {n.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="pb-enter">
          <Link className="pb-btn pb-btn-ghost" href="/login">
            Comercio
          </Link>
          <Link className="pb-btn pb-btn-dark" href="/personal/entrar">
            Entrar
          </Link>
        </div>
        <details className="pb-menu">
          <summary>
            <span>Menú</span>
          </summary>
          <nav aria-label="Principal (móvil)">
            <ul>
              {NAV.map((n) => (
                <li key={n.href}>
                  <Link href={n.href} aria-current={current === n.href ? 'page' : undefined}>
                    {n.label}
                  </Link>
                </li>
              ))}
              <li>
                <Link href="/personal/entrar">Entrar a Personal</Link>
              </li>
              <li>
                <Link href="/login">Entrar como comercio</Link>
              </li>
            </ul>
          </nav>
        </details>
      </header>
      <main id="pb-main" className="pb-main" tabIndex={-1}>
        {children}
      </main>
      <footer className="pb-foot">
        <div className="pb-foot-brand">
          <FluviaLogo height={20} tone="white" />
          <p>Entorno de demostración. Ninguna operación mueve dinero real.</p>
        </div>
        <ul className="pb-foot-links">
          <li>
            <Link href="/ayuda">Centro de ayuda</Link>
          </li>
          <li>
            <Link href="/creditos">Créditos y licencias</Link>
          </li>
          <li>
            <Link href="/signup">Registrar un comercio</Link>
          </li>
        </ul>
      </footer>
    </div>
  );
}

/** Encabezado de sección con enlace opcional «Ver todo». */
export function SectionHead({
  id,
  title,
  lead,
  more,
}: {
  id: string;
  title: string;
  lead?: string;
  more?: { href: string; label: string };
}) {
  return (
    <div className="pb-sec-head">
      <div>
        <h2 id={id}>{title}</h2>
        {lead ? <p>{lead}</p> : null}
      </div>
      {more ? (
        <Link className="pb-more" href={more.href}>
          {more.label} <Icon name="arrow-right" size={16} />
        </Link>
      ) : null}
    </div>
  );
}
