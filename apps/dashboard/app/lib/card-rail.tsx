'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './icons';

/**
 * Carril horizontal de tarjetas verticales. Sin reproducción automática.
 *  - Táctil: desplazamiento nativo con *scroll-snap*; en móvil asoma la
 *    siguiente tarjeta.
 *  - Teclado: cada tarjeta es un enlace (Tab recorre el carril y el navegador
 *    la trae a la vista); los botones Anterior/Siguiente avanzan una tarjeta.
 *  - El carril contiene su propio desbordamiento: la página no gana scroll
 *    horizontal.
 */
export function CardRail({ label, children }: { label: string; children: ReactNode }) {
  const ref = useRef<HTMLUListElement>(null);
  const [edge, setEdge] = useState({ start: true, end: false });

  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setEdge({
      start: el.scrollLeft <= 4,
      end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 4,
    });
  }, []);

  useEffect(() => {
    update();
    const el = ref.current;
    if (!el) return;
    el.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      el.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [update]);

  const step = (dir: 1 | -1) => {
    const el = ref.current;
    if (!el) return;
    const card = el.querySelector('li');
    const w = card ? card.getBoundingClientRect().width + 16 : el.clientWidth * 0.8;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollBy({ left: dir * w, behavior: reduce ? 'auto' : 'smooth' });
  };

  return (
    <div className="pb-rail" role="group" aria-roledescription="carrusel" aria-label={label}>
      <ul ref={ref} className="pb-rail-track">
        {children}
      </ul>
      <div className="pb-rail-ctrl">
        <button
          type="button"
          className="pb-icon-btn"
          onClick={() => step(-1)}
          disabled={edge.start}
          aria-label={`${label}: anterior`}
        >
          <Icon name="chevron-left" size={20} />
        </button>
        <button
          type="button"
          className="pb-icon-btn"
          onClick={() => step(1)}
          disabled={edge.end}
          aria-label={`${label}: siguiente`}
        >
          <Icon name="chevron-right" size={20} />
        </button>
      </div>
    </div>
  );
}
