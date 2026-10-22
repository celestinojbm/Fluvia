'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { FluviaLogo } from '../brand';
import { NAV, SANDBOX_HREF } from '../content';
import { Button } from './button';
import { Icon } from './icons';

function NavLinks({ onNavigate, pathname }: { onNavigate?: () => void; pathname: string }) {
  return (
    <ul>
      {NAV.map((item) => {
        const current = item.href === '/precios' && pathname === '/precios';
        return (
          <li key={item.label}>
            <a href={item.href} aria-current={current ? 'page' : undefined} onClick={onNavigate}>
              {item.label}
            </a>
          </li>
        );
      })}
    </ul>
  );
}

export function Header() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, [open]);

  return (
    <header className="site-header">
      <a className="logo-link" href="/">
        <FluviaLogo height={28} tone="black" />
      </a>
      <nav className="nav-desktop" aria-label="Secciones">
        <NavLinks pathname={pathname} />
      </nav>
      <div className="header-cta">
        <Button href={SANDBOX_HREF} variant="primary" icon={<Icon name="arrow" size={16} />}>
          Cómo funciona
        </Button>
        <button
          type="button"
          className="menu-btn"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((value) => !value)}
        >
          <Icon name={open ? 'close' : 'menu'} size={20} />
          <span className="sr-only">{open ? 'Cerrar menú' : 'Abrir menú'}</span>
        </button>
      </div>
      <div
        id={panelId}
        className="nav-panel"
        hidden={!open}
        role="dialog"
        aria-modal="true"
        aria-label="Menú"
      >
        <button ref={closeRef} type="button" className="menu-btn" onClick={() => setOpen(false)}>
          <Icon name="close" size={20} />
          <span className="sr-only">Cerrar menú</span>
        </button>
        <nav aria-label="Secciones">
          <NavLinks pathname={pathname} onNavigate={() => setOpen(false)} />
        </nav>
        <Button href={SANDBOX_HREF} variant="primary" icon={<Icon name="arrow" size={16} />}>
          Cómo funciona
        </Button>
      </div>
    </header>
  );
}
