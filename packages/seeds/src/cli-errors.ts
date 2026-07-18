import { ShowroomUnverifiedTargetError } from './live-identity.js';
import {
  ShowroomResetGuardError,
  ShowroomResetSequenceError,
  ShowroomSeedGuardError,
  ShowroomTargetRemovedError,
} from './reset.js';
import {
  ShowroomAlreadySeededError,
  ShowroomDatabaseMismatchError,
  ShowroomEnvironmentError,
  ShowroomSeedError,
} from './showroom.js';

/**
 * RA-F65C3-EXT-006 — formatter COMPARTIDO de errores de los dos CLIs del
 * showroom (`showroom:seed` y `demo:reset`). Politica:
 *
 *  - Errores CONOCIDOS (clases tipadas de este paquete): su mensaje es estable
 *    y controlado por nosotros (jamas transporta URLs, credenciales, SQL crudo
 *    ni secretos) => se imprime `<cli> fallo: <mensaje>`. La `cause` interna
 *    (p. ej. la de ShowroomTargetRemovedError) NUNCA se imprime.
 *  - Errores DESCONOCIDOS: NO se imprime el objeto, ni stack, ni cause, ni
 *    message crudo, ni config/URL/connectionString/userinfo/query/password/
 *    tokens. Solo una linea generica con la fase y, cuando es seguro, el
 *    nombre de la clase y un `code` corto validado por allowlist de FORMA
 *    (SQLSTATE de 5 caracteres alfanumericos en mayuscula, o errno estilo
 *    Node `E...` — nunca texto libre donde quepa un secreto).
 *
 * No existe un "modo debug" que vuelque el error crudo: quien depura corre el
 * flujo desde el checkout con su propio tooling, no desde el CLI.
 */

const KNOWN_ERROR_CLASSES: ReadonlyArray<abstract new (...args: never[]) => Error> = [
  ShowroomResetGuardError,
  ShowroomSeedGuardError,
  ShowroomResetSequenceError,
  ShowroomTargetRemovedError,
  ShowroomEnvironmentError,
  ShowroomAlreadySeededError,
  ShowroomSeedError,
  ShowroomDatabaseMismatchError,
  ShowroomUnverifiedTargetError,
];

/** Nombre de clase imprimible: identificador corto, sin espacio para secretos. */
const SAFE_CLASS_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,49}$/;

/**
 * Allowlist de FORMA para `code` de errores desconocidos: SQLSTATE ('42501',
 * 'XX000', '28P01'…) o errno de Node ('ECONNREFUSED', 'ENOENT'…). Todo lo
 * demas (texto libre, minusculas, longitudes raras) se OMITE — un token o un
 * secreto jamas pasa esta forma.
 */
const SAFE_CODE_RE = /^(?:[0-9A-Z]{5}|E[A-Z]{2,30})$/;

/** Fase imprimible: identificador corto interno (jamas texto de error). */
const SAFE_PHASE_RE = /^[a-z0-9-]{1,32}$/;

export function formatSafeShowroomCliError(
  cli: 'showroom:seed' | 'demo:reset',
  error: unknown,
  phase: string
): string {
  for (const known of KNOWN_ERROR_CLASSES) {
    if (error instanceof known) {
      // Mensaje estable y controlado; la cause interna JAMAS se imprime.
      return `${cli} fallo: ${(error as Error).message}`;
    }
  }

  const safePhase = SAFE_PHASE_RE.test(phase) ? phase : 'desconocida';
  let suffix = '';
  if (error !== null && typeof error === 'object') {
    const className = (error as { constructor?: { name?: unknown } }).constructor?.name;
    const code = (error as { code?: unknown }).code;
    const parts: string[] = [];
    if (typeof className === 'string' && SAFE_CLASS_NAME_RE.test(className)) {
      parts.push(className);
    }
    if (typeof code === 'string' && SAFE_CODE_RE.test(code)) {
      parts.push(`code ${code}`);
    }
    if (parts.length > 0) suffix = ` (${parts.join(', ')})`;
  }
  return `${cli} fallo inesperado [unexpected_error] en fase ${safePhase}${suffix}`;
}
