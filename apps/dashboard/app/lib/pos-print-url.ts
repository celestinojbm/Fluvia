/**
 * URL de impresión SIN identificadores.
 *
 * Los navegadores (Chrome, Firefox, Safari) pueden imprimir en el pie la URL
 * del documento en el momento de imprimir; la del justificante lleva el id
 * COMPLETO de la organización y del cobro. La aplicación no controla la
 * casilla «encabezados y pies de página» del diálogo, pero SÍ controla la URL
 * del documento: se sustituye con `history.replaceState` por `PRINT_PATH`
 * (ruta existente y sin ids) ANTES de imprimir y se restaura después.
 *
 * Comprobado en Chromium real (PDF con pie `url`, ver docs/product/pos-sandbox.md):
 *  - el pie usa la URL que hay al INICIAR la impresión, ANTES de `beforeprint`:
 *    cambiarla en `beforeprint` no la quita del pie;
 *  - por eso el botón «Imprimir» y el atajo Ctrl/Cmd+P (interceptado) cambian
 *    la URL y DESPUÉS llaman a `window.print()`: pie sin ids;
 *  - «Imprimir» desde el MENÚ del navegador no se puede interceptar: ahí el pie
 *    puede llevar la URL completa (queda el aviso en pantalla). El listener
 *    `beforeprint` se mantiene como defensa adicional para navegadores que
 *    lean la URL más tarde (no verificado en ellos).
 *
 * Seguridad: `replaceState` es same-origin, no navega, no carga nada ni crea
 * rutas nuevas; si `afterprint` no llegara, la URL queda en `/` (la página de
 * inicio, que exige sesión) y la vista sigue siendo la misma.
 */
export const PRINT_PATH = '/';

export interface PrintUrlGuard {
  /** Sustituye la URL (idempotente). */
  hide(): void;
  /** Restaura la URL original (idempotente). */
  restore(): void;
  /** Sustituye la URL, imprime y la restaura (nada si `canPrint()` es false). */
  print(): void;
  /** Quita los listeners y restaura. */
  dispose(): void;
}

export function installPrintUrlGuard(
  win: Window,
  opts: { printPath?: string; canPrint?: () => boolean } = {}
): PrintUrlGuard {
  const printPath = opts.printPath ?? PRINT_PATH;
  const canPrint = opts.canPrint ?? (() => true);
  let saved: string | null = null;
  const hide = () => {
    if (saved !== null) return;
    const { pathname, search, hash } = win.location;
    const original = `${pathname}${search}${hash}`;
    try {
      win.history.replaceState(win.history.state, '', printPath);
      saved = original;
    } catch {
      /* sin history: la URL no se puede cambiar (queda el aviso) */
    }
  };
  const restore = () => {
    if (saved === null) return;
    const original = saved;
    saved = null;
    try {
      win.history.replaceState(win.history.state, '', original);
    } catch {
      /* sin history */
    }
  };
  const print = () => {
    if (!canPrint()) return;
    hide();
    try {
      win.print();
    } finally {
      // Chrome/Firefox bloquean en print(); si el navegador no bloquea,
      // `afterprint` restaurará igualmente (restore es idempotente).
      restore();
    }
  };
  // Ctrl/Cmd+P: el navegador tomaría la URL antes de `beforeprint`; se
  // intercepta el atajo para imprimir por el mismo camino que el botón.
  const onKey = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'p') {
      // Con datos no imprimibles (desactualizados, cargando) el atajo tampoco
      // imprime: mismo bloqueo que el botón.
      e.preventDefault();
      print();
    }
  };
  win.addEventListener('beforeprint', hide);
  win.addEventListener('afterprint', restore);
  win.addEventListener('keydown', onKey);
  return {
    hide,
    restore,
    print,
    dispose: () => {
      win.removeEventListener('beforeprint', hide);
      win.removeEventListener('afterprint', restore);
      win.removeEventListener('keydown', onKey);
      restore();
    },
  };
}
