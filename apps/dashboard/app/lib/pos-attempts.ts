import { UUID_RE } from './pos-contract';

/**
 * Registro LOCAL (esta pestaña: `sessionStorage` es por pestaña y se pierde al
 * cerrarla) de los checkouts que el terminal abrió para cada venta:
 * `linkId → [sessionId…]`. Existe porque la API no persiste la relación
 * venta→sesiones (gap G3): no es un sustituto de ese contrato y la UI lo
 * presenta como «abiertos desde esta pestaña».
 *
 * Solo guarda ids devueltos por el BFF (nunca el `client_secret` ni la URL de
 * pago). Todo acceso va en try/catch: sin almacenamiento, el terminal sigue
 * funcionando con lo que tiene en memoria.
 */

const MAX_SALES = 20;
const MAX_ATTEMPTS = 10;

type Registry = Array<{ link: string; sessions: string[] }>;

const keyOf = (orgId: string) => `fluvia.pos.sales.v1:${orgId}`;

function read(orgId: string): Registry {
  try {
    const raw = window.sessionStorage.getItem(keyOf(orgId));
    const v = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(v)) return [];
    return v.filter(
      (e): e is Registry[number] =>
        typeof e?.link === 'string' &&
        UUID_RE.test(e.link) &&
        Array.isArray(e.sessions) &&
        e.sessions.every((s: unknown) => typeof s === 'string' && UUID_RE.test(s))
    );
  } catch {
    return [];
  }
}

function write(orgId: string, reg: Registry): void {
  try {
    window.sessionStorage.setItem(keyOf(orgId), JSON.stringify(reg));
  } catch {
    /* almacenamiento no disponible: solo memoria */
  }
}

export function recordAttempt(orgId: string, linkId: string, sessionId: string): void {
  const reg = read(orgId).filter((e) => e.link !== linkId);
  const prev = read(orgId).find((e) => e.link === linkId)?.sessions ?? [];
  const sessions = [...prev.filter((s) => s !== sessionId), sessionId].slice(-MAX_ATTEMPTS);
  write(orgId, [...reg, { link: linkId, sessions }].slice(-MAX_SALES));
}

/** Checkouts abiertos desde esta pestaña para la venta, del más antiguo al último. */
export function attemptsFor(orgId: string, linkId: string): string[] {
  return read(orgId).find((e) => e.link === linkId)?.sessions ?? [];
}

/** Venta de una sesión, si la abrió esta pestaña; si no, null (no se adivina). */
export function linkForSession(orgId: string, sessionId: string): string | null {
  return read(orgId).find((e) => e.sessions.includes(sessionId))?.link ?? null;
}
