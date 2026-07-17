import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool as realCreatePool, migrate } from '@fluvia/db';
import { buildShowroomSemanticManifest, type ShowroomSemanticManifest } from './manifest.js';
import { seedShowroom, type ShowroomSeedResult } from './showroom.js';

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

interface ParsedDbUrl {
  /** hostname normalizado (sin corchetes IPv6, lowercase). */
  host: string;
  /** puerto EFECTIVO (default 5432 si la URL no lo fija). */
  port: string;
  dbName: string;
}

/**
 * Parsing fail-closed con `URL`. Se normaliza SOLO lo necesario para comparar
 * (hostname, puerto efectivo, dbname del pathname). Rechaza: esquema no
 * postgres, hostname vacio, userinfo-sin-host, pathname vacio o con multiples
 * segmentos, caracteres fuera de [A-Za-z0-9_] en el dbname (lo que elimina de
 * raiz percent-encoding ambiguo), query strings (en libpq `?host=`/`?dbname=`
 * pueden REDIRIGIR el destino) y fragments. Sin resolucion DNS.
 */
function parseDbUrl(label: string, raw: string): ParsedDbUrl {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ShowroomResetGuardError('url_invalid', `${label}: not a parseable URL`);
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new ShowroomResetGuardError('url_invalid', `${label}: protocol must be postgres://`);
  }
  if (url.search !== '' || url.hash !== '') {
    throw new ShowroomResetGuardError(
      'url_invalid',
      `${label}: query/fragment can ambiguously alter the destination and are rejected`
    );
  }
  const hostRaw = url.hostname;
  if (hostRaw === '') {
    throw new ShowroomResetGuardError(
      'url_invalid',
      `${label}: empty hostname (unix sockets are ambiguous and rejected)`
    );
  }
  // Un solo segmento de pathname, caracteres explicitos: sin '%', sin '/'.
  const path = url.pathname;
  const m = /^\/([A-Za-z0-9_]+)$/.exec(path);
  if (!m) {
    throw new ShowroomResetGuardError(
      'url_invalid',
      `${label}: pathname must be a single plain database name segment`
    );
  }
  const host = hostRaw.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  return { host, port: url.port === '' ? '5432' : url.port, dbName: m[1]! };
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

  const targets = SHOWROOM_DB_ROLES.map((role) => ({
    role,
    parsed: parseDbUrl(`target[${role}]`, req.targetUrls[role]),
  }));
  const maintenance = parseDbUrl('maintenance', req.maintenanceUrl);

  for (const t of targets) {
    // [3] Target exacto: fluvia_showroom o fluvia_showroom_test_<id> estricto.
    if (t.parsed.dbName !== SHOWROOM_TARGET_DB && !SHOWROOM_TEST_TARGET_RE.test(t.parsed.dbName)) {
      throw new ShowroomResetGuardError(
        'target_name_invalid',
        `target[${t.role}] dbname "${t.parsed.dbName}" is not ${SHOWROOM_TARGET_DB} nor ${SHOWROOM_TEST_TARGET_RE.source}`
      );
    }
    // [4] + [10] Ninguna URL target puede apuntar a una base del sistema o a
    // la principal (redundante con [3] a proposito: defensa en profundidad).
    if (RESET_TARGET_DENYLIST.has(t.parsed.dbName)) {
      throw new ShowroomResetGuardError(
        'target_denylisted',
        `target[${t.role}] dbname "${t.parsed.dbName}" is denylisted`
      );
    }
  }

  // [5] TODAS las URLs target comparten dbname.
  const dbNames = new Set(targets.map((t) => t.parsed.dbName));
  if (dbNames.size !== 1) {
    throw new ShowroomResetGuardError(
      'target_dbnames_differ',
      `target URLs point at different databases: ${[...dbNames].join(', ')}`
    );
  }
  const targetDbName = targets[0]!.parsed.dbName;

  // [6] Todos los hosts (target y maintenance) son loopback LITERAL (sin DNS).
  for (const entry of [
    ...targets.map((t) => ({ label: t.role, p: t.parsed })),
    { label: 'maintenance', p: maintenance },
  ]) {
    if (!LOOPBACK_HOSTS.has(entry.p.host)) {
      throw new ShowroomResetGuardError(
        'host_not_loopback',
        `${entry.label} host "${entry.p.host}" is not localhost/127.0.0.1/::1`
      );
    }
  }

  // [7] Maintenance y target comparten host y puerto (mismo cluster). Los
  // targets ademas deben ser homogeneos entre si.
  const hostPorts = new Set(targets.map((t) => `${t.parsed.host}:${t.parsed.port}`));
  if (hostPorts.size !== 1) {
    throw new ShowroomResetGuardError(
      'maintenance_target_mismatch',
      `target URLs span multiple host:port pairs: ${[...hostPorts].join(', ')}`
    );
  }
  const [targetHostPort] = hostPorts;
  if (`${maintenance.host}:${maintenance.port}` !== targetHostPort) {
    throw new ShowroomResetGuardError(
      'maintenance_target_mismatch',
      `maintenance ${maintenance.host}:${maintenance.port} does not match target ${targetHostPort}`
    );
  }

  // [8] La base de mantenimiento es DISTINTA del target.
  if (maintenance.dbName === targetDbName) {
    throw new ShowroomResetGuardError(
      'maintenance_equals_target',
      `maintenance database equals the drop target "${targetDbName}"`
    );
  }
  // [9] La base de mantenimiento pertenece a la allowlist literal.
  if (!MAINTENANCE_DB_ALLOWLIST.has(maintenance.dbName)) {
    throw new ShowroomResetGuardError(
      'maintenance_not_allowlisted',
      `maintenance database "${maintenance.dbName}" is not in the allowlist (postgres)`
    );
  }

  const targetParsed = targets[0]!.parsed;
  return {
    targetDbName,
    maintenanceDbName: maintenance.dbName,
    host: targetParsed.host,
    port: targetParsed.port,
  };
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
  try {
    // UNA sola sesion fisica para todo el bloque de mantenimiento: el
    // advisory lock de abajo es de SESION y debe vivir y morir con ella.
    const session = await maintenance.connect();
    try {
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
      try {
        // Identificador YA validado por regex; se cita ADEMAS con quote_ident
        // de PostgreSQL (jamas interpolacion cruda de un nombre arbitrario).
        const quoted = await session.query<{ q: string }>('SELECT quote_ident($1) AS q', [
          plan.targetDbName,
        ]);
        const ident = quoted.rows[0]!.q;
        // WITH (FORCE): termina de forma dirigida las sesiones del TARGET (y
        // solo del target) antes de dropearlo.
        await session.query(`DROP DATABASE IF EXISTS ${ident} WITH (FORCE)`);
        await session.query(`CREATE DATABASE ${ident}`);
      } finally {
        await session
          .query('SELECT pg_advisory_unlock($1)', [SHOWROOM_RESET_LOCK_KEY])
          .catch(() => undefined);
      }
    } finally {
      session.release();
    }
  } finally {
    await maintenance.end();
  }

  deps.onPhase?.('migrate');
  const admin = createPool({ connectionString: req.targetUrls.admin, max: 2 });
  try {
    // El advisory lock del runner de migraciones es POR BASE; varios resets
    // CONCURRENTES (tests de integracion) migran bases efimeras DISTINTAS a la
    // vez y las migraciones que tocan catalogos COMPARTIDOS del cluster
    // (p. ej. `ALTER ROLE … NOBYPASSRLS` en 0009 — pg_authid) pueden chocar
    // transitoriamente con «tuple concurrently updated». Cada archivo corre en
    // su propia transaccion y esas sentencias son idempotentes, asi que un
    // reintento ACOTADO y especifico de ESE error converge sin ocultar fallos
    // reales de migracion (cualquier otro error se propaga al primer intento).
    for (let attempt = 1; ; attempt++) {
      try {
        await migrate(admin, undefined, { environment: req.env });
        break;
      } catch (err) {
        if (attempt >= 10 || !/tuple concurrently updated/.test(String(err))) throw err;
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
      }
    }
  } finally {
    await admin.end();
  }
  return plan;
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

  const admin = createPool({ connectionString: req.targetUrls.admin, max: 4 });
  const app = createPool({ connectionString: req.targetUrls.app, max: 8 });
  const auth = createPool({ connectionString: req.targetUrls.auth, max: 2 });
  const relay = createPool({ connectionString: req.targetUrls.relay, max: 2 });
  const webhook = createPool({ connectionString: req.targetUrls.webhook, max: 2 });
  try {
    deps.onPhase?.('seed');
    const seed = await seedShowroom(
      req.env,
      { admin, app, auth, relay, webhook },
      { onPhase: deps.onSeedPhase }
    );

    deps.onPhase?.('invariants');
    const script = readFileSync(INVARIANTS_SCRIPT_PATH, 'utf8');
    await admin.query(script);

    deps.onPhase?.('manifest');
    const manifest = await buildShowroomSemanticManifest(admin);

    return { targetDbName: plan.targetDbName, seed, manifest, invariants: 'passed' };
  } finally {
    await Promise.all([admin.end(), app.end(), auth.end(), relay.end(), webhook.end()]);
  }
}
