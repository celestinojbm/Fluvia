/**
 * Modelo del banco de mostrador.
 *
 * La ficha recorre un eje, de la bandeja de quien paga al cajón del comercio.
 * Si se suelta antes del tope, el muelle la devuelve. Solo queda en el cajón
 * si el recorrido se completa. El cajón de crédito no entra en este eje:
 * está cerrado y no alimenta la bandeja.
 *
 * Las palabras del readout salen de aquí. No hay importes ni métricas.
 */

export const HOME = -74;
export const END = 68;
export const SPAN = END - HOME;

const LATCH_AT = END - 1.2;
const TRAY_AT = HOME + 1.2;

export type Station = 'tray' | 'moving' | 'till';

export function clampTravel(x: number): number {
  return Math.min(END, Math.max(HOME, x));
}

export function stationOf(x: number, latched: boolean): Station {
  const at = clampTravel(x);
  if (latched && at >= LATCH_AT) return 'till';
  if (at <= TRAY_AT) return 'tray';
  return 'moving';
}

export function readoutOf(x: number, latched: boolean): string {
  const station = stationOf(x, latched);
  if (station === 'tray') return 'en la bandeja';
  if (station === 'till') return 'en el cajón';
  return 'en camino';
}

export function travelFromScreen(screenX: number, homeScreen: number, endScreen: number): number {
  const span = endScreen - homeScreen;
  if (span === 0) return HOME;
  const share = (screenX - homeScreen) / span;
  return clampTravel(HOME + Math.min(1, Math.max(0, share)) * SPAN);
}

const ease = (u: number) => {
  const v = Math.min(1, Math.max(0, u));
  return v * v * (3 - 2 * v);
};

/** Recorrido en reposo: sale, llega, espera y el muelle la devuelve. */
export function tourTarget(t: number): { x: number; latched: boolean } {
  const loop = 9.6;
  const at = ((t % loop) + loop) % loop;
  if (at < 1.1) return { x: HOME, latched: false };
  if (at < 4.1) return { x: HOME + SPAN * ease((at - 1.1) / 3), latched: false };
  if (at < 6.3) return { x: END, latched: true };
  if (at < 8.3) {
    return { x: HOME + SPAN * (1 - ease((at - 6.3) / 2)), latched: false };
  }
  return { x: HOME, latched: false };
}
