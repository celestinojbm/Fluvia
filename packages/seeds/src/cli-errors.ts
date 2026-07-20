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
 * showroom. Politica (delta):
 *
 *  - Errores CONOCIDOS: se imprime una PLANTILLA FIJA por clase/code — JAMAS
 *    `error.message` (varias clases aceptan un `detail` externo que podria
 *    transportar URLs/SQL/secretos), jamas `cause`, jamas `err.name` externo.
 *    Los `code` de guard se validan contra conjuntos CERRADOS literales.
 *  - Errores DESCONOCIDOS: una unica linea generica
 *    `<cli> fallo inesperado [unexpected_error] en fase <fase>` — sin acceso a
 *    NINGUNA propiedad del objeto (un getter hostil, un Proxy que lanza en
 *    get/getPrototypeOf o un objeto circular no pueden romper ni contaminar la
 *    salida). Ni className, ni code, ni stack, ni message, ni cause.
 *  - La fase se valida contra una forma cerrada (identificador corto) o se
 *    degrada a `desconocida`. No existe modo debug que vuelque el error crudo.
 *
 * Todo el matching corre dentro de un try/catch: si CUALQUIER paso lanza
 * (p. ej. `instanceof` sobre un Proxy hostil dispara getPrototypeOf), la
 * salida degrada a la linea generica con fase `desconocida`.
 */

export type ShowroomCliName = 'showroom:seed' | 'demo:reset';

/** Fase imprimible: identificador corto interno (jamas texto de error). */
const SAFE_PHASE_RE = /^[a-z0-9-]{1,32}$/;

/** Conjuntos CERRADOS de codes de guard (literales, sin regex abierta). */
const RESET_GUARD_CODES: ReadonlySet<string> = new Set([
  'env_not_allowed',
  'confirmation_mismatch',
  'url_invalid',
  'target_name_invalid',
  'target_denylisted',
  'target_dbnames_differ',
  'host_not_loopback',
  'maintenance_target_mismatch',
  'maintenance_equals_target',
  'maintenance_not_allowlisted',
]);
const SEED_GUARD_CODES: ReadonlySet<string> = new Set([
  'env_not_allowed',
  'url_invalid',
  'target_name_invalid',
  'target_denylisted',
  'target_dbnames_differ',
  'host_not_loopback',
  'target_host_port_differ',
]);

/**
 * Lectura SEGURA de una propiedad propia: solo `descriptor.value` (jamas un
 * getter), con toda falla degradada a undefined.
 */
function safeOwnStringValue(obj: object, key: string): string | undefined {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(obj, key);
    if (
      descriptor === undefined ||
      descriptor.get !== undefined ||
      !('value' in descriptor) ||
      typeof descriptor.value !== 'string'
    ) {
      return undefined;
    }
    return descriptor.value;
  } catch {
    return undefined;
  }
}

function guardTemplate(
  cli: ShowroomCliName,
  error: object,
  allowedCodes: ReadonlySet<string>
): string | undefined {
  const code = safeOwnStringValue(error, 'code');
  if (code === undefined || !allowedCodes.has(code)) return undefined;
  if (code === 'confirmation_mismatch') {
    return `${cli} blocked: pass --confirm RESET_FLUVIA_SHOWROOM to authorize the destructive reset [confirmation_mismatch]`;
  }
  return `${cli} blocked by target guard [${code}]`;
}

/**
 * Devuelve UNA linea segura para stderr. Nunca lanza; nunca refleja material
 * externo (detail/message/cause/stack/config/URLs/secretos).
 */
export function formatSafeShowroomCliError(
  cli: ShowroomCliName,
  error: unknown,
  phase: string
): string {
  let safePhase = 'desconocida';
  try {
    if (typeof phase === 'string' && SAFE_PHASE_RE.test(phase)) safePhase = phase;
  } catch {
    safePhase = 'desconocida';
  }
  const unexpected = `${cli} fallo inesperado [unexpected_error] en fase ${safePhase}`;

  try {
    if (error === null || typeof error !== 'object') return unexpected;

    // Plantillas FIJAS por clase conocida (jamas error.message).
    if (error instanceof ShowroomResetGuardError) {
      return guardTemplate(cli, error, RESET_GUARD_CODES) ?? unexpected;
    }
    if (error instanceof ShowroomSeedGuardError) {
      return guardTemplate(cli, error, SEED_GUARD_CODES) ?? unexpected;
    }
    if (error instanceof ShowroomEnvironmentError) {
      return `${cli} blocked: showroom tooling is local/test-only [env_not_allowed]`;
    }
    if (error instanceof ShowroomTargetRemovedError) {
      return `${cli}: the dedicated showroom database was removed (DROP succeeded) but CREATE did not complete; migrate/seed/invariants never started — run demo:reset again to rebuild [target_removed_rebuild_required]`;
    }
    if (error instanceof ShowroomResetSequenceError) {
      return `${cli}: reset sequence failed at a guarded maintenance step [reset_sequence_failed]`;
    }
    if (error instanceof ShowroomAlreadySeededError) {
      return `${cli}: showroom data already exists; rebuild with: pnpm demo:reset -- --confirm RESET_FLUVIA_SHOWROOM [already_seeded]`;
    }
    if (error instanceof ShowroomDatabaseMismatchError) {
      return `${cli}: showroom target identity mismatch (live attestation rejected the databases behind the pools) [target_database_mismatch]`;
    }
    if (error instanceof ShowroomUnverifiedTargetError) {
      return `${cli}: showroom target verification failed (seedShowroom only accepts a handle produced by verifyShowroomTarget) [target_not_verified]`;
    }
    if (error instanceof ShowroomSeedError) {
      return `${cli}: showroom seed postcondition failed; rebuild with demo:reset [seed_postcondition_failed]`;
    }

    return unexpected;
  } catch {
    // instanceof sobre un Proxy hostil puede lanzar (getPrototypeOf trap):
    // degradacion total a la linea generica.
    return `${cli} fallo inesperado [unexpected_error] en fase desconocida`;
  }
}
