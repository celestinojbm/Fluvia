import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool as realCreatePool, migrate, type Pool, type PoolClient } from '@fluvia/db';
import { verifyShowroomTarget, type VerifiedShowroomTarget } from './live-identity.js';
import { buildShowroomSemanticManifest, type ShowroomSemanticManifest } from './manifest.js';
import { seedShowroom, type ShowroomPools, type ShowroomSeedResult } from './showroom.js';

/**
 * `demo:reset` (F6.5C3, decision B2) — reset DESTRUCTIVO por DROP/CREATE de la
 * base DEDICADA del showroom. JAMAS toca la base principal `fluvia`:
 *
 *  - El unico target destructivo permitido es `fluvia_showroom` (o una base
 *    efimera `fluvia_showroom_test_<id>` para integracion automatizada).
 *  - El guard de DIEZ condiciones corre COMPLETO antes de abrir cualquier
 *    conexion, crear cualquier pool o resolver nada: si una condicion falla,
 *    el proceso termina con un error tipado y CERO efectos.
 *  - La conexion de MANTENIMIENTO (necesaria porque PostgreSQL no permite
 *    dropear la base de la propia sesion) es una URL SEPARADA y explicita
 *    (`SHOWROOM_MAINTENANCE_DATABASE_URL`), jamas derivada de una URL target;
 *    su dbname vive en una allowlist literal (solo `postgres`) y NUNCA puede
 *    ser el target del DROP.
 *
 * Mecanismo sancionado en el repo: pool de mantenimiento que ejecuta
 * `CREATE DATABASE` / `DROP DATABASE ... WITH (FORCE)` contra una base ajena
 * (patron `packages/db/test/migration-guard.test.ts`), formalizado aqui con
 * URLs explicitas, guard fail-closed y quoting `quote_ident` del identificador.
 */

const INVARIANTS_SCRIPT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../scripts/verify-ledger-invariants.sql'
);

/** Nombre EXACTO de la base dedicada del showroom. */
export const SHOWROOM_TARGET_DB = 'fluvia_showroom';

/** Regex ESTRICTA de la base efimera de integracion: fluvia_showroom_test_<id>. */
export const SHOWROOM_TEST_TARGET_RE = /^fluvia_showroom_test_[a-z0-9]{1,32}$/;

/** Denylist dura: NINGUNA de estas puede ser jamas el target destructivo. */
export const RESET_TARGET_DENYLIST = new Set(['fluvia', 'postgres', 'template0', 'template1']);

/** Allowlist literal de la base de MANTENIMIENTO (fail-closed: solo postgres). */
export const MAINTENANCE_DB_ALLOWLIST = new Set(['postgres']);

/** Confirmacion literal obligatoria del comando destructivo. */
export const RESET_CONFIRMATION = 'RESET_FLUVIA_SHOWROOM';

/**
 * Advisory lock de sesion (sobre la base de MANTENIMIENTO compartida) que
 * serializa el DROP/CREATE de resets concurrentes. Distinta de la clave del
 * runner de migraciones (727270, "FLUVIA").
 */
const SHOWROOM_RESET_LOCK_KEY = 727_273;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/** Roles de BD que el showroom REALMENTE usa (no se asume una URL unica). */
export interface ShowroomDbUrls {
  /** Superusuario local: migraciones + lecturas read-only de verificacion. */
  admin: string;
  /** fluvia_app: TODOS los servicios de dominio bajo RLS. */
  app: string;
  /** fluvia_auth: registro sandbox atomico (AuthService). */
  auth: string;
  /** fluvia_relay: outbox relay + fan-out de webhooks. */
  relay: string;
  /** fluvia_webhook: deliverer de webhooks salientes. */
  webhook: string;
}

export const SHOWROOM_DB_ROLES = ['admin', 'app', 'auth', 'relay', 'webhook'] as const;

export interface ShowroomResetRequest {
  /** Entorno efectivo. El guard exige EXACTAMENTE 'local' o 'test'. */
  env: string;
  /** Debe ser literalmente RESET_FLUVIA_SHOWROOM. */
  confirm: string | undefined;
  /** URLs por rol hacia la base OBJETIVO (todas el MISMO dbname target). */
  targetUrls: ShowroomDbUrls;
  /** URL de MANTENIMIENTO explicita (variable propia, jamas derivada). */
  maintenanceUrl: string;
}

export type ShowroomResetGuardCode =
  | 'env_not_allowed' // [1]
  | 'confirmation_mismatch' // [2]
  | 'url_invalid' // parsing fail-closed (hostname vacio, query, multi-segmento…)
  | 'target_name_invalid' // [3]
  | 'target_denylisted' // [4] / [10]
  | 'target_dbnames_differ' // [5]
  | 'host_not_loopback' // [6]
  | 'maintenance_target_mismatch' // [7] (host o puerto distintos)
  | 'maintenance_equals_target' // [8]
  | 'maintenance_not_allowlisted'; // [9]

/** Error tipado y estable del guard: cero conexiones, cero efectos. */
export class ShowroomResetGuardError extends Error {
  constructor(
    readonly code: ShowroomResetGuardCode,
    detail: string
  ) {
    super(`demo:reset blocked (${code}): ${detail}`);
    this.name = 'ShowroomResetGuardError';
  }
}

/** Fallo posterior al guard (secuencia de reset): tambien tipado y estable. */
export class ShowroomResetSequenceError extends Error {
  constructor(detail: string) {
    super(`demo:reset sequence failed: ${detail}`);
    this.name = 'ShowroomResetSequenceError';
  }
}

/**
 * RA-F65C3-EXT-004 — el DROP del target TERMINO pero el CREATE posterior NO:
 * la base dedicada quedo ELIMINADA y debe reconstruirse volviendo a ejecutar
 * `demo:reset`. Error tipado con codigo estable; la causa original queda SOLO
 * para uso interno (`cause`) — el CLI jamas la imprime (puede contener SQL
 * crudo o detalles del driver). El mensaje publico no incluye SQL, URLs ni
 * credenciales.
 */
export class ShowroomTargetRemovedError extends Error {
  readonly code = 'target_removed_rebuild_required';
  constructor(targetDbName: string, cause: unknown) {
    super(
      `demo:reset removed the dedicated database "${targetDbName}" (DROP succeeded) but CREATE DATABASE did not complete; migrate/seed/invariants never started. The target no longer exists: run demo:reset again to rebuild it from scratch.`,
      { cause }
    );
    this.name = 'ShowroomTargetRemovedError';
  }
}

interface ParsedDbUrl {
  /** hostname normalizado (sin corchetes IPv6, lowercase). */
  host: string;
  /** puerto EFECTIVO (default 5432 si la URL no lo fija). */
  port: string;
  dbName: string;
}

/**
 * Codigos del validador COMPARTIDO de URLs target (una sola politica para el
 * reset y para el seed — jamas dos copias que puedan divergir). Cada guard los
 * traduce a su propio error tipado mediante su `raise`.
 */
type TargetGuardCode =
  | 'url_invalid'
  | 'target_name_invalid'
  | 'target_denylisted'
  | 'target_dbnames_differ'
  | 'host_not_loopback'
  | 'target_host_port_differ';

type TargetGuardRaise = (code: TargetGuardCode, detail: string) => never;

/**
 * Parsing fail-closed con `URL`. Se normaliza SOLO lo necesario para comparar
 * (hostname, puerto efectivo, dbname del pathname). Rechaza: esquema no
 * postgres, hostname vacio, userinfo-sin-host, pathname vacio o con multiples
 * segmentos, caracteres fuera de [A-Za-z0-9_] en el dbname (lo que elimina de
 * raiz percent-encoding ambiguo), query strings (en libpq `?host=`/`?dbname=`
 * pueden REDIRIGIR el destino) y fragments. Sin resolucion DNS.
 */
function parseDbUrl(label: string, raw: string, raise: TargetGuardRaise): ParsedDbUrl {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    raise('url_invalid', `${label}: not a parseable URL`);
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    raise('url_invalid', `${label}: protocol must be postgres://`);
  }
  if (url.search !== '' || url.hash !== '') {
    raise(
      'url_invalid',
      `${label}: query/fragment can ambiguously alter the destination and are rejected`
    );
  }
  const hostRaw = url.hostname;
  if (hostRaw === '') {
    raise('url_invalid', `${label}: empty hostname (unix sockets are ambiguous and rejected)`);
  }
  // Un solo segmento de pathname, caracteres explicitos: sin '%', sin '/'.
  const path = url.pathname;
  const m = /^\/([A-Za-z0-9_]+)$/.exec(path);
  if (!m) {
    raise('url_invalid', `${label}: pathname must be a single plain database name segment`);
  }
  const host = hostRaw.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  return { host, port: url.port === '' ? '5432' : url.port, dbName: m[1]! };
}

export interface ShowroomTargetPlan {
  targetDbName: string;
  host: string;
  port: string;
}

/**
 * Validador COMPARTIDO de la identidad del TARGET dedicado (reset Y seed):
 * parsea las 5 URLs por rol, exige nombre exacto `fluvia_showroom` o la regex
 * estricta de test, aplica la denylist por URL (defensa en profundidad), exige
 * el MISMO dbname en todas, hosts loopback LITERALES (sin DNS) y el mismo
 * host:puerto efectivo entre roles. PURO: sin I/O, sin pools.
 */
function validateDedicatedTargets(
  targetUrls: ShowroomDbUrls,
  raise: TargetGuardRaise
): ShowroomTargetPlan {
  const targets = SHOWROOM_DB_ROLES.map((role) => ({
    role,
    parsed: parseDbUrl(`target[${role}]`, targetUrls[role], raise),
  }));

  for (const t of targets) {
    // Target exacto: fluvia_showroom o fluvia_showroom_test_<id> estricto.
    if (t.parsed.dbName !== SHOWROOM_TARGET_DB && !SHOWROOM_TEST_TARGET_RE.test(t.parsed.dbName)) {
      raise(
        'target_name_invalid',
        `target[${t.role}] dbname "${t.parsed.dbName}" is not ${SHOWROOM_TARGET_DB} nor ${SHOWROOM_TEST_TARGET_RE.source}`
      );
    }
    // Ninguna URL target puede apuntar a una base del sistema o a la
    // principal (redundante con la regex a proposito: defensa en profundidad).
    if (RESET_TARGET_DENYLIST.has(t.parsed.dbName)) {
      raise('target_denylisted', `target[${t.role}] dbname "${t.parsed.dbName}" is denylisted`);
    }
  }

  // TODAS las URLs target comparten dbname.
  const dbNames = new Set(targets.map((t) => t.parsed.dbName));
  if (dbNames.size !== 1) {
    raise(
      'target_dbnames_differ',
      `target URLs point at different databases: ${[...dbNames].join(', ')}`
    );
  }

  // Todos los hosts target son loopback LITERAL (sin resolucion DNS).
  for (const t of targets) {
    if (!LOOPBACK_HOSTS.has(t.parsed.host)) {
      raise(
        'host_not_loopback',
        `target[${t.role}] host "${t.parsed.host}" is not localhost/127.0.0.1/::1`
      );
    }
  }

  // Todas las URLs target comparten host y puerto EFECTIVO (mismo cluster).
  const hostPorts = new Set(targets.map((t) => `${t.parsed.host}:${t.parsed.port}`));
  if (hostPorts.size !== 1) {
    raise(
      'target_host_port_differ',
      `target URLs span multiple host:port pairs: ${[...hostPorts].join(', ')}`
    );
  }

  const parsed = targets[0]!.parsed;
  return { targetDbName: parsed.dbName, host: parsed.host, port: parsed.port };
}

export interface ShowroomResetPlan {
  targetDbName: string;
  maintenanceDbName: string;
  host: string;
  port: string;
}

/**
 * Guard de DIEZ condiciones (decision B2, plan F6.5C §6) — PURO: sin I/O, sin
 * DNS, sin pools. Cualquier violacion lanza ShowroomResetGuardError con code
 * estable. Solo si TODO pasa se devuelve el plan (nombres ya validados).
 */
export function assertShowroomResetAllowed(req: ShowroomResetRequest): ShowroomResetPlan {
  // [1] Entorno exacto local/test.
  if (req.env !== 'local' && req.env !== 'test') {
    throw new ShowroomResetGuardError('env_not_allowed', `env "${req.env}" is not local/test`);
  }
  // [2] Confirmacion literal.
  if (req.confirm !== RESET_CONFIRMATION) {
    throw new ShowroomResetGuardError(
      'confirmation_mismatch',
      `pass --confirm ${RESET_CONFIRMATION} to authorize the destructive reset`
    );
  }

  // [3][4][5][6-target][10] + homogeneidad host:puerto de los targets: el
  // validador COMPARTIDO con el guard del seed (una sola politica). El codigo
  // publico del reset conserva su forma historica (`maintenance_target_mismatch`
  // cubre tambien la homogeneidad entre targets).
  const resetRaise: TargetGuardRaise = (code, detail) => {
    throw new ShowroomResetGuardError(
      code === 'target_host_port_differ' ? 'maintenance_target_mismatch' : code,
      detail
    );
  };
  const target = validateDedicatedTargets(req.targetUrls, resetRaise);
  const maintenance = parseDbUrl('maintenance', req.maintenanceUrl, resetRaise);

  // [6] La maintenance tambien debe ser loopback LITERAL (sin DNS).
  if (!LOOPBACK_HOSTS.has(maintenance.host)) {
    throw new ShowroomResetGuardError(
      'host_not_loopback',
      `maintenance host "${maintenance.host}" is not localhost/127.0.0.1/::1`
    );
  }

  // [7] Maintenance y target comparten host y puerto (mismo cluster).
  if (maintenance.host !== target.host || maintenance.port !== target.port) {
    throw new ShowroomResetGuardError(
      'maintenance_target_mismatch',
      `maintenance ${maintenance.host}:${maintenance.port} does not match target ${target.host}:${target.port}`
    );
  }

  // [8] La base de mantenimiento es DISTINTA del target.
  if (maintenance.dbName === target.targetDbName) {
    throw new ShowroomResetGuardError(
      'maintenance_equals_target',
      `maintenance database equals the drop target "${target.targetDbName}"`
    );
  }
  // [9] La base de mantenimiento pertenece a la allowlist literal.
  if (!MAINTENANCE_DB_ALLOWLIST.has(maintenance.dbName)) {
    throw new ShowroomResetGuardError(
      'maintenance_not_allowlisted',
      `maintenance database "${maintenance.dbName}" is not in the allowlist (postgres)`
    );
  }

  return {
    targetDbName: target.targetDbName,
    maintenanceDbName: maintenance.dbName,
    host: target.host,
    port: target.port,
  };
}

// ---------------------------------------------------------------------------
// Guard del SEED (F6.5C3, revision pre-auditoria): `showroom:seed` tambien es
// un camino de ESCRITURA hacia una base y debe demostrar por si mismo que su
// target es la base DEDICADA — sin depender del reset. Misma politica de URLs
// (validador compartido), sin confirmacion (el seed no es destructivo) y sin
// plano maintenance (el seed no dropea nada).
// ---------------------------------------------------------------------------

export type ShowroomSeedGuardCode = 'env_not_allowed' | TargetGuardCode;

/** Error tipado y estable del guard del seed: cero conexiones, cero efectos. */
export class ShowroomSeedGuardError extends Error {
  constructor(
    readonly code: ShowroomSeedGuardCode,
    detail: string
  ) {
    super(`showroom:seed blocked (${code}): ${detail}`);
    this.name = 'ShowroomSeedGuardError';
  }
}

export interface ShowroomSeedTargetRequest {
  /** Entorno efectivo. El guard exige EXACTAMENTE 'local' o 'test'. */
  env: string;
  /** URLs por rol hacia la base OBJETIVO del seed (mismo dbname dedicado). */
  targetUrls: ShowroomDbUrls;
}

/**
 * Guard PURO del `showroom:seed` — corre COMPLETO antes de crear cualquier
 * pool/conexion (sin I/O, sin DNS): env exacto local/test + el validador
 * compartido del target dedicado (parse fail-closed, nombre exacto o regex
 * estricta, denylist `fluvia`/`postgres`/`template0`/`template1`, mismo dbname
 * en los 5 roles, hosts loopback literales, mismo host:puerto efectivo).
 */
export function assertShowroomSeedTargetAllowed(
  req: ShowroomSeedTargetRequest
): ShowroomTargetPlan {
  if (req.env !== 'local' && req.env !== 'test') {
    throw new ShowroomSeedGuardError('env_not_allowed', `env "${req.env}" is not local/test`);
  }
  return validateDedicatedTargets(req.targetUrls, (code, detail) => {
    throw new ShowroomSeedGuardError(code, detail);
  });
}

/** Tamaños de pool por rol (identicos en seed y reset: una sola politica). */
const SHOWROOM_POOL_SIZES: Record<(typeof SHOWROOM_DB_ROLES)[number], number> = {
  admin: 4,
  app: 8,
  auth: 2,
  relay: 2,
  webhook: 2,
};

/**
 * RA-F65C3-EXT-003 — apertura SEGURA de los cinco pools del showroom: cada
 * pool se registra inmediatamente al crearse; si el factory falla en cualquier
 * posicion, TODOS los anteriores se cierran (`Promise.allSettled`: un fallo de
 * cleanup no oculta el error original) y no se crea ninguno posterior. Cero
 * handles vivos tras un fallo. No imprime connection strings. Sirve tanto a
 * `showroom:seed` como a `demo:reset`.
 */
export async function openShowroomPoolsSafely(
  targetUrls: ShowroomDbUrls,
  createPool: typeof realCreatePool = realCreatePool
): Promise<ShowroomPools> {
  const opened: Pick<Pool, 'end'>[] = [];
  const partial: Partial<Record<(typeof SHOWROOM_DB_ROLES)[number], Pool>> = {};
  try {
    for (const role of SHOWROOM_DB_ROLES) {
      const pool = createPool({
        connectionString: targetUrls[role],
        max: SHOWROOM_POOL_SIZES[role],
      });
      opened.push(pool);
      partial[role] = pool;
    }
    return partial as ShowroomPools;
  } catch (err) {
    await Promise.allSettled(opened.map((pool) => pool.end()));
    throw err;
  }
}

/**
 * UNICA via del CLI `showroom:seed` hacia un target utilizable, en el orden
 * exacto del flujo autorizado: guard PURO de URLs (cero I/O; un rechazo jamas
 * invoca el factory) -> apertura segura de pools (cleanup ante fallo parcial)
 * -> attestation LIVE de identidad unica -> handle verificado. Si la
 * attestation falla, los cinco pools se cierran aqui mismo (sin fuga) y el
 * error original se propaga.
 */
export interface ShowroomOpenedTarget {
  /** Handle OPACO para seedShowroom (el estado vive en el modulo privado). */
  target: VerifiedShowroomTarget;
  /** Nombre del target autorizado por el guard puro (sin URLs/credenciales). */
  targetDbName: string;
  /** Cierra los cinco pools abiertos por esta via (allSettled, sin fuga). */
  close(): Promise<void>;
}

export async function openVerifiedShowroomTarget(
  env: string,
  targetUrls: ShowroomDbUrls,
  createPool: typeof realCreatePool = realCreatePool
): Promise<ShowroomOpenedTarget> {
  const plan = assertShowroomSeedTargetAllowed({ env, targetUrls });
  const pools = await openShowroomPoolsSafely(targetUrls, createPool);
  const close = async (): Promise<void> => {
    await Promise.allSettled([
      pools.admin.end(),
      pools.app.end(),
      pools.auth.end(),
      pools.relay.end(),
      pools.webhook.end(),
    ]);
  };
  try {
    const target = await verifyShowroomTarget(env, pools, { plan });
    return { target, targetDbName: plan.targetDbName, close };
  } catch (err) {
    await close();
    throw err;
  }
}

/**
 * URLs del showroom desde el entorno. Variables PROPIAS (jamas se reutilizan
 * las de la base principal, jamas se deriva una de otra): con defaults SOLO en
 * local/test (patron AUD-P2-014 de `dbUrlsFromEnv`).
 */
export interface ShowroomEnvUrls {
  targetUrls: ShowroomDbUrls;
  maintenanceUrl: string;
}

export function showroomUrlsFromEnv(env: NodeJS.ProcessEnv = process.env): ShowroomEnvUrls {
  const runtimeEnv = (env.FLUVIA_ENV ?? env.NODE_ENV ?? '').toLowerCase();
  const isLocal = new Set(['development', 'dev', 'test', 'local', '']).has(runtimeEnv);
  const missing: string[] = [];
  const pick = (name: string, value: string | undefined, localDefault: string): string => {
    if (value) return value;
    if (isLocal) return localDefault;
    missing.push(name);
    return '';
  };
  const base = `127.0.0.1:5432/${SHOWROOM_TARGET_DB}`;
  const urls: ShowroomEnvUrls = {
    targetUrls: {
      admin: pick(
        'SHOWROOM_ADMIN_DATABASE_URL',
        env.SHOWROOM_ADMIN_DATABASE_URL,
        `postgres://postgres:postgres@${base}`
      ),
      app: pick(
        'SHOWROOM_APP_DATABASE_URL',
        env.SHOWROOM_APP_DATABASE_URL,
        `postgres://fluvia_app:fluvia_app_dev_password@${base}`
      ),
      auth: pick(
        'SHOWROOM_AUTH_DATABASE_URL',
        env.SHOWROOM_AUTH_DATABASE_URL,
        `postgres://fluvia_auth:fluvia_auth_dev_password@${base}`
      ),
      relay: pick(
        'SHOWROOM_RELAY_DATABASE_URL',
        env.SHOWROOM_RELAY_DATABASE_URL,
        `postgres://fluvia_relay:fluvia_relay_dev_password@${base}`
      ),
      webhook: pick(
        'SHOWROOM_WEBHOOK_DATABASE_URL',
        env.SHOWROOM_WEBHOOK_DATABASE_URL,
        `postgres://fluvia_webhook:fluvia_webhook_dev_password@${base}`
      ),
    },
    maintenanceUrl: pick(
      'SHOWROOM_MAINTENANCE_DATABASE_URL',
      env.SHOWROOM_MAINTENANCE_DATABASE_URL,
      'postgres://postgres:postgres@127.0.0.1:5432/postgres'
    ),
  };
  if (missing.length > 0) {
    throw new Error(
      `FLUVIA_CONFIG: environment "${runtimeEnv}" requires explicit showroom database URLs; missing: ${missing.join(', ')}`
    );
  }
  return urls;
}

export type ShowroomResetPhase =
  'guard' | 'drop-create' | 'migrate' | 'seed' | 'invariants' | 'manifest';

export interface ShowroomResetDeps {
  /**
   * Factory de conexiones INYECTABLE: los tests fail-closed prueban de forma
   * objetiva que el guard aborta SIN invocarlo jamas, y el test del reset real
   * captura TODOS los dbnames usados. Default: `createPool` de @fluvia/db.
   */
  createPool?: typeof realCreatePool;
  onPhase?: (phase: ShowroomResetPhase) => void;
  /** Observador de fase del seed (progreso del CLI). */
  onSeedPhase?: (phase: string) => void;
  /**
   * Seams de test CONDUCTUAL del retry de migracion (RA-F65C3-EXT-005): los
   * tests inyectan un migrateFn/sleepFn scriptados para contar intentos y
   * delays exactos. Defaults: `migrate` de @fluvia/db y setTimeout real. No
   * son hooks de runtime publico — viven en las deps ya inyectables del reset.
   */
  migrateFn?: typeof migrate;
  sleepFn?: (ms: number) => Promise<void>;
}

export interface ShowroomResetResult {
  targetDbName: string;
  seed: ShowroomSeedResult;
  manifest: ShowroomSemanticManifest;
  invariants: 'passed';
}

/**
 * Recrea la base dedicada: guard completo -> UNICA conexion de mantenimiento
 * -> re-check `current_database()` -> DROP ... WITH (FORCE) -> CREATE -> cierre
 * TOTAL del pool de mantenimiento -> migraciones sobre el target. La conexion
 * de mantenimiento JAMAS queda abierta durante migrate/seed.
 */
export async function prepareShowroomDatabase(
  req: ShowroomResetRequest,
  deps: ShowroomResetDeps = {}
): Promise<ShowroomResetPlan> {
  const createPool = deps.createPool ?? realCreatePool;
  deps.onPhase?.('guard');
  const plan = assertShowroomResetAllowed(req);

  deps.onPhase?.('drop-create');
  const maintenance = createPool({ connectionString: req.maintenanceUrl, max: 1 });
  // PRESERVACION DEL ERROR PRIMARIO (delta RA-F65C3-EXT-004): el error
  // operativo (recheck fallido, DROP fallido, o el CRITICO
  // ShowroomTargetRemovedError de un CREATE fallido tras el DROP) JAMAS es
  // sustituido por un fallo del cleanup (unlock/release/end). Cada recurso
  // recibe SU intento de cleanup en orden (un unlock fallido no impide el
  // release; un release fallido no impide el end); los fallos secundarios se
  // registran solo como CODIGOS de paso fijos (jamas message/URL/SQL crudos),
  // adjuntos de forma NO enumerable al error primario. Si NO hay error
  // primario y el cleanup falla, se lanza un error tipado y sanitizado.
  let session: PoolClient | undefined;
  let lockTaken = false;
  let hasPrimary = false;
  let primaryError: unknown;
  try {
    // UNA sola sesion fisica para todo el bloque de mantenimiento: el
    // advisory lock de abajo es de SESION y debe vivir y morir con ella.
    session = await maintenance.connect();
    // Re-check en vivo: la sesion de mantenimiento debe estar en una base de
    // la allowlist y NUNCA en el target (defensa contra una URL enganosa que
    // el parser no anticipo — la BD dice la verdad).
    const current = await session.query<{ db: string }>('SELECT current_database() AS db');
    const currentDb = current.rows[0]!.db;
    if (!MAINTENANCE_DB_ALLOWLIST.has(currentDb) || currentDb === plan.targetDbName) {
      throw new ShowroomResetSequenceError(
        `maintenance session is connected to "${currentDb}", expected an allowlisted maintenance database`
      );
    }
    // Serializa DROP/CREATE entre resets CONCURRENTES (los tests de
    // integracion preparan varias bases efimeras en paralelo): dos CREATE
    // DATABASE simultaneos chocan porque ambos copian template1 («source
    // database is being accessed by other users»). Advisory lock de sesion
    // sobre la base de mantenimiento compartida (precedente: el runner de
    // migraciones usa la misma primitiva con su propia clave).
    await session.query('SELECT pg_advisory_lock($1)', [SHOWROOM_RESET_LOCK_KEY]);
    lockTaken = true;
    // Identificador YA validado por regex; se cita ADEMAS con quote_ident
    // de PostgreSQL (jamas interpolacion cruda de un nombre arbitrario).
    const quoted = await session.query<{ q: string }>('SELECT quote_ident($1) AS q', [
      plan.targetDbName,
    ]);
    const ident = quoted.rows[0]!.q;
    // Maquina de fases explicita (RA-F65C3-EXT-004): un fallo del CREATE
    // DESPUES de un DROP exitoso deja el target ELIMINADO — ese estado se
    // comunica con un error tipado estable, no con el error crudo del
    // driver. Antes del DROP, cualquier fallo se propaga tal cual (el
    // target sigue existiendo o nunca existio; nada que reconstruir).
    let stage: 'before_drop' | 'target_dropped' | 'target_created' = 'before_drop';
    // WITH (FORCE): termina de forma dirigida las sesiones del TARGET (y
    // solo del target) antes de dropearlo.
    await session.query(`DROP DATABASE IF EXISTS ${ident} WITH (FORCE)`);
    stage = 'target_dropped';
    try {
      await session.query(`CREATE DATABASE ${ident}`);
      stage = 'target_created';
    } catch (createErr) {
      if (stage === 'target_dropped') {
        throw new ShowroomTargetRemovedError(plan.targetDbName, createErr);
      }
      throw createErr;
    }
  } catch (error) {
    hasPrimary = true;
    primaryError = error;
  }
  {
    // Cleanup SIEMPRE (el catch de arriba captura todo primario, asi que este
    // bloque corre en todos los caminos; deliberadamente FUERA de un finally:
    // relanzar desde finally puede pisar excepciones en vuelo — la esencia
    // del finding EXT-004 — y aqui ya no hay ninguna en vuelo).
    const cleanupFailures: string[] = [];
    if (session !== undefined && lockTaken) {
      try {
        await session.query('SELECT pg_advisory_unlock($1)', [SHOWROOM_RESET_LOCK_KEY]);
      } catch {
        cleanupFailures.push('advisory_unlock');
      }
    }
    if (session !== undefined) {
      try {
        session.release();
      } catch {
        cleanupFailures.push('session_release');
      }
    }
    try {
      await maintenance.end();
    } catch {
      cleanupFailures.push('maintenance_end');
    }
    if (hasPrimary) {
      if (cleanupFailures.length > 0 && primaryError !== null && typeof primaryError === 'object') {
        // Registro seguro de fallos secundarios: SOLO codigos de paso fijos,
        // NO enumerable (jamas viaja a serializaciones/outputs por accidente).
        Object.defineProperty(primaryError, 'cleanupFailureSteps', {
          value: Object.freeze([...cleanupFailures]),
          enumerable: false,
          configurable: false,
          writable: false,
        });
      }
      throw primaryError;
    }
    if (cleanupFailures.length > 0) {
      throw new ShowroomResetSequenceError(
        `maintenance cleanup failed (${cleanupFailures.join('/')})`
      );
    }
  }

  deps.onPhase?.('migrate');
  const admin = createPool({ connectionString: req.targetUrls.admin, max: 2 });
  const migrateFn = deps.migrateFn ?? migrate;
  const sleepFn = deps.sleepFn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let migrateError: unknown;
  let hasMigrateError = false;
  try {
    // El advisory lock del runner de migraciones es POR BASE; varios resets
    // CONCURRENTES (tests de integracion) migran bases efimeras DISTINTAS a la
    // vez y las migraciones que tocan catalogos COMPARTIDOS del cluster
    // (p. ej. `ALTER ROLE … NOBYPASSRLS` en 0009 — pg_authid) pueden chocar
    // transitoriamente con «tuple concurrently updated». Cada archivo corre en
    // su propia transaccion y esas sentencias son idempotentes, asi que un
    // reintento ACOTADO y ESTRUCTURADO de ESE error (SQLSTATE + mensaje
    // exactos, no un match de texto) converge sin ocultar fallos reales de
    // migracion (cualquier otro error se propaga al primer intento).
    for (let attempt = 1; ; attempt++) {
      try {
        await migrateFn(admin, undefined, { environment: req.env });
        break;
      } catch (err) {
        if (attempt >= MIGRATE_RETRY_MAX_ATTEMPTS || !isRetryableTupleConcurrentlyUpdated(err)) {
          throw err;
        }
        await sleepFn(250 * attempt);
      }
    }
  } catch (error) {
    hasMigrateError = true;
    migrateError = error;
  }
  {
    // Mismo patron que el bloque de mantenimiento: cleanup fuera de finally.
    let adminEndFailed = false;
    try {
      await admin.end();
    } catch {
      adminEndFailed = true;
    }
    if (hasMigrateError) throw migrateError;
    if (adminEndFailed) {
      throw new ShowroomResetSequenceError('maintenance cleanup failed (admin_pool_end)');
    }
  }
  return plan;
}

// ---------------------------------------------------------------------------
// RA-F65C3-EXT-005 — clasificador ESTRUCTURADO del unico error de migracion
// reintentable. Campos observados EMPIRICAMENTE en PostgreSQL 16.13 al chocar
// dos `ALTER ROLE` concurrentes sobre pg_authid (node-postgres DatabaseError):
//   code (SQLSTATE): 'XX000' (internal_error)
//   message:         'tuple concurrently updated'
//   routine:         'simple_heap_update'  (informativo; NO se exige — otras
//                    rutas de catalogo emiten el mismo error con otra routine)
// El runner de migraciones envuelve el fallo por archivo en un Error propio
// con `{ cause }`, asi que el clasificador recorre la cadena `cause` acotada.
// ---------------------------------------------------------------------------

/** SQLSTATE exacto del error concurrente observado (internal_error). */
export const TUPLE_CONCURRENTLY_UPDATED_SQLSTATE = 'XX000';
/** Mensaje exacto del error concurrente observado. */
export const TUPLE_CONCURRENTLY_UPDATED_MESSAGE = 'tuple concurrently updated';

const MIGRATE_RETRY_MAX_ATTEMPTS = 10;

/**
 * true SOLO para el error estructurado exacto: SQLSTATE 'XX000' Y mensaje
 * 'tuple concurrently updated' en el propio error o en su cadena `cause`
 * (acotada). Mismo texto con otro SQLSTATE => no. SQLSTATE correcto con otro
 * mensaje => no. Errores sin estructura (sin `code`), de permisos, de SQL, de
 * integridad, de red o de autenticacion => no.
 */
export function isRetryableTupleConcurrentlyUpdated(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 10 && current !== null && typeof current === 'object'; depth++) {
    const { code, message } = current as { code?: unknown; message?: unknown };
    if (
      code === TUPLE_CONCURRENTLY_UPDATED_SQLSTATE &&
      message === TUPLE_CONCURRENTLY_UPDATED_MESSAGE
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Reset completo: prepare (guard -> DROP/CREATE -> migrate) -> pools target ->
 * `seedShowroom` -> invariantes [1]-[9] -> manifiesto semantico. Todos los
 * pools se cierran incluso ante error.
 */
export async function runShowroomReset(
  req: ShowroomResetRequest,
  deps: ShowroomResetDeps = {}
): Promise<ShowroomResetResult> {
  const createPool = deps.createPool ?? realCreatePool;
  const plan = await prepareShowroomDatabase(req, deps);

  // Apertura SEGURA (fallo parcial => cierre de los ya creados) y luego la
  // MISMA attestation live + handle verificado que exige el camino del seed
  // standalone: el reset no tiene un atajo hacia seedShowroom.
  const pools = await openShowroomPoolsSafely(req.targetUrls, createPool);
  try {
    deps.onPhase?.('seed');
    const target = await verifyShowroomTarget(req.env, pools, {
      plan: { targetDbName: plan.targetDbName, host: plan.host, port: plan.port },
    });
    const seed = await seedShowroom(req.env, target, { onPhase: deps.onSeedPhase });

    deps.onPhase?.('invariants');
    const script = readFileSync(INVARIANTS_SCRIPT_PATH, 'utf8');
    await pools.admin.query(script);

    deps.onPhase?.('manifest');
    const manifest = await buildShowroomSemanticManifest(pools.admin);

    return { targetDbName: plan.targetDbName, seed, manifest, invariants: 'passed' };
  } finally {
    await Promise.all([
      pools.admin.end(),
      pools.app.end(),
      pools.auth.end(),
      pools.relay.end(),
      pools.webhook.end(),
    ]);
  }
}
