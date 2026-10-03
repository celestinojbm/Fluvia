'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Icon } from '../../lib/icons';

/**
 * Ocultar importes (privacidad visual en lugares públicos). Preferencia de ESTE
 * dispositivo (localStorage), no de la cuenta: se dice así en la interfaz.
 * Los importes envueltos en `.pm-money` se tapan con CSS; el valor real sigue
 * en el DOM para lectores de pantalla del propio usuario.
 */
const KEY = 'fluvia.personal.hideAmounts';
const Ctx = createContext<{ hidden: boolean; toggle: () => void }>({
  hidden: false,
  toggle: () => undefined,
});

export function HideAmountsProvider({ children }: { children: ReactNode }) {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    try {
      setHidden(window.localStorage.getItem(KEY) === '1');
    } catch {
      /* almacenamiento no disponible: se muestra todo */
    }
  }, []);
  useEffect(() => {
    document.documentElement.dataset.hideAmounts = hidden ? '1' : '0';
  }, [hidden]);
  const toggle = () =>
    setHidden((h) => {
      try {
        window.localStorage.setItem(KEY, h ? '0' : '1');
      } catch {
        /* sin persistencia: solo esta vista */
      }
      return !h;
    });
  return <Ctx.Provider value={{ hidden, toggle }}>{children}</Ctx.Provider>;
}

export function HideAmountsButton() {
  const { hidden, toggle } = useContext(Ctx);
  return (
    <button
      type="button"
      className="pm-icon-btn"
      aria-pressed={hidden}
      onClick={toggle}
      title={hidden ? 'Mostrar importes' : 'Ocultar importes'}
    >
      <Icon name={hidden ? 'eye-off' : 'eye'} size={20} />
      <span className="sr-only">{hidden ? 'Mostrar importes' : 'Ocultar importes'}</span>
    </button>
  );
}

export function HideAmountsSwitch() {
  const { hidden, toggle } = useContext(Ctx);
  return (
    <label className="pm-option" style={{ minHeight: 56 }}>
      <input type="checkbox" checked={hidden} onChange={toggle} />
      <span className="pm-option-body">
        <span className="pm-option-title">Ocultar importes</span>
        <span className="pm-option-sub" style={{ display: 'block' }}>
          Solo en este dispositivo. Útil al usar la app en público.
        </span>
      </span>
    </label>
  );
}
