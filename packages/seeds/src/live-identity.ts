import type { Pool } from '@fluvia/db';
import {
  RESET_TARGET_DENYLIST,
  SHOWROOM_DB_ROLES,
  SHOWROOM_TARGET_DB,
  SHOWROOM_TEST_TARGET_RE,
  type ShowroomTargetPlan,
} from './reset.js';
import {
  ShowroomDatabaseMismatchError,
  ShowroomEnvironmentError,
  type ShowroomPools,
} from './showroom.js';

/**
 * Identidad LIVE del target del showroom (RA-F65C3-EXT-001).
 *
 * `current_database()` por pool NO basta: cinco clusters PostgreSQL distintos
 * pueden tener todos una base llamada `fluvia_showroom`. Antes de cualquier
 * mutacion, los CINCO roles deben demostrar que estan conectados al MISMO
 * servidor real, no solo a bases con el mismo nombre. La identidad se observa
 * read-only preguntandole a la propia base:
 *
 *  - `current_database()`        -> nombre real de la base (dedicada, denylist);
 *  - `inet_server_addr()`        -> direccion LOCAL del servidor para esta
 *                                   conexion (NULL en sockets Unix => rechazo:
 *                                   la identidad exige endpoint TCP observable);
 *  - `inet_server_port()`        -> puerto real del servidor (no el de la URL);
 *  - `pg_postmaster_start_time()`-> instante de arranque del postmaster
 *                                   (microsegundos: dos clusters no lo comparten);
 *  - `pg_control_system().system_identifier` -> identificador ESTABLE del
 *    cluster generado por initdb. En PostgreSQL 16 es ejecutable por los cinco
 *    roles reales sin grants (verificado empiricamente); si algun rol recibe
 *    `insufficient_privilege` (42501) NO se ignora en silencio: la identidad
 *    degrada explicitamente a endpoint live + postmaster (fail-closed: esos
 *    campos siguen siendo obligatorios y deben coincidir exactamente), y los
 *    identificadores que SI se observaron deben coincidir entre si.
 *
 * Ademas del chequeo, `seedShowroom` exige un HANDLE runtime opaco
 * (`VerifiedShowroomTarget`) que SOLO produce `verifyShowroomTarget` en este
 * modulo: un objeto de pools plano, un cast de TypeScript o una copia
 * estructural del handle se rechazan en runtime (WeakSet privado) antes de
 * consultar contenido o mutar nada.
 */

export interface ShowroomLiveDatabaseIdentity {
  /** current_database() — identico en los cinco roles y dedicado. */
  database: string;
  /** inet_server_addr() — jamas null (exige endpoint TCP observable). */
  serverAddress: string;
  /** inet_server_port() — jamas null. */
  serverPort: number;
  /** pg_postmaster_start_time()::text — coincide exactamente entre roles. */
  postmasterStartedAt: string;
  /**
   * pg_control_system().system_identifier — presente SOLO cuando los cinco
   * roles pudieron leerlo; cuando existe, debe coincidir exactamente.
   */
  clusterIdentifier?: string;
}

/**
 * `seedShowroom` recibio algo que NO es un handle producido por
 * `verifyShowroomTarget` (pools planos, cast, copia estructural). Distinto de
 * ShowroomDatabaseMismatchError: aqui ni siquiera hay identidad que comparar.
 */
export class ShowroomUnverifiedTargetError extends Error {
  readonly code = 'target_not_verified';
  constructor() {
    super(
      'seedShowroom requires a VerifiedShowroomTarget produced by verifyShowroomTarget (a plain pools object or a structural copy is rejected before touching any database)'
    );
    this.name = 'ShowroomUnverifiedTargetError';
  }
}

/** Handle runtime OPACO: solo `verifyShowroomTarget` puede producir uno valido. */
export interface VerifiedShowroomTarget {
  readonly pools: ShowroomPools;
  /** Identidad live observada en la attestation (base del re-chequeo TOCTOU). */
  readonly identity: ShowroomLiveDatabaseIdentity;
  /** Plan del guard puro de URLs cuando el flujo venia de URLs (CLI/reset). */
  readonly plan: ShowroomTargetPlan | null;
}

/**
 * Marca runtime privada: WeakSet (autoridad — una copia `{ ...handle }` o un
 * `Object.create(handle)` NO estan en el set) + Symbol no exportado (defensa
 * adicional y señal de depuracion). Ninguno de los dos sale de este modulo.
 */
const VERIFIED_TARGETS = new WeakSet<object>();
const VERIFIED_BRAND = Symbol('fluvia.showroom.verified-target');

const TIMESTAMPTZ_TEXT_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{2}(:?\d{2})?$/;

interface IdentityRow {
  database: unknown;
  server_address: unknown;
  server_port: unknown;
  postmaster_started_at: unknown;
  cluster_identifier?: unknown;
}

const IDENTITY_SQL = `SELECT current_database() AS database,
       host(inet_server_addr()) AS server_address,
       inet_server_port()::text AS server_port,
       pg_postmaster_start_time()::text AS postmaster_started_at`;

const CLUSTER_SQL = `SELECT system_identifier::text AS cluster_identifier FROM pg_control_system()`;

interface ObservedIdentity extends ShowroomLiveDatabaseIdentity {
  /** null => este rol recibio 42501 al leer pg_control_system(). */
  observedClusterIdentifier: string | null;
}

function fail(detail: string): never {
  throw new ShowroomDatabaseMismatchError(detail);
}

/** Observa la identidad live de UN pool. Cualquier respuesta ausente,
 *  inesperada o parcial aborta (fail-closed). Read-only. */
async function observePoolIdentity(role: string, pool: Pool): Promise<ObservedIdentity> {
  let row: IdentityRow | undefined;
  try {
    row = (await pool.query<IdentityRow>(IDENTITY_SQL)).rows[0];
  } catch (err) {
    fail(`pool "${role}": live identity query failed (${(err as Error).name ?? 'error'})`);
  }
  if (!row) fail(`pool "${role}": live identity query returned no row`);
  const { database, server_address, server_port, postmaster_started_at } = row;
  if (typeof database !== 'string' || database === '') {
    fail(`pool "${role}": current_database() missing`);
  }
  if (typeof server_address !== 'string' || server_address === '') {
    fail(
      `pool "${role}": inet_server_addr() is null (unix-socket or unobservable endpoint rejected)`
    );
  }
  const port = typeof server_port === 'string' ? Number(server_port) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    fail(`pool "${role}": inet_server_port() is null or not a valid port`);
  }
  if (
    typeof postmaster_started_at !== 'string' ||
    !TIMESTAMPTZ_TEXT_RE.test(postmaster_started_at)
  ) {
    fail(`pool "${role}": pg_postmaster_start_time() is missing or malformed`);
  }

  // system_identifier: normativo cuando es legible; 42501 degrada EXPLICITO.
  let observedClusterIdentifier: string | null = null;
  try {
    const res = await pool.query<{ cluster_identifier: unknown }>(CLUSTER_SQL);
    const id = res.rows[0]?.cluster_identifier;
    if (typeof id !== 'string' || !/^\d{1,32}$/.test(id)) {
      fail(`pool "${role}": pg_control_system() returned an unexpected system_identifier`);
    }
    observedClusterIdentifier = id;
  } catch (err) {
    if (err instanceof ShowroomDatabaseMismatchError) throw err;
    if ((err as { code?: unknown }).code !== '42501') {
      fail(`pool "${role}": pg_control_system() query failed (${(err as Error).name ?? 'error'})`);
    }
    // 42501 (insufficient_privilege): unico caso en que el identificador de
    // cluster puede faltar; la identidad endpoint+postmaster sigue siendo
    // obligatoria y exacta.
  }

  return {
    database,
    serverAddress: server_address,
    serverPort: port,
    postmasterStartedAt: postmaster_started_at,
    observedClusterIdentifier,
  };
}

/**
 * Observa y CONSOLIDA la identidad live de los cinco pools: los cinco deben
 * reportar exactamente la misma base dedicada, el mismo endpoint del servidor
 * (addr+port), el mismo arranque de postmaster y — cuando exista — el mismo
 * system_identifier. Cualquier divergencia o respuesta parcial aborta.
 */
export async function observeShowroomLiveIdentity(
  pools: ShowroomPools
): Promise<ShowroomLiveDatabaseIdentity> {
  const observed: Array<[string, ObservedIdentity]> = [];
  for (const role of SHOWROOM_DB_ROLES) {
    observed.push([role, await observePoolIdentity(role, pools[role])]);
  }

  const describe = (pick: (o: ObservedIdentity) => string) =>
    observed.map(([r, o]) => `${r}=${pick(o)}`).join(', ');

  const databases = new Set(observed.map(([, o]) => o.database));
  if (databases.size !== 1) {
    fail(`pools are connected to DIFFERENT databases: ${describe((o) => o.database)}`);
  }
  const endpoints = new Set(observed.map(([, o]) => `${o.serverAddress}:${o.serverPort}`));
  if (endpoints.size !== 1) {
    fail(
      `pools are connected to DIFFERENT live server endpoints: ${describe(
        (o) => `${o.serverAddress}:${o.serverPort}`
      )}`
    );
  }
  const starts = new Set(observed.map(([, o]) => o.postmasterStartedAt));
  if (starts.size !== 1) {
    fail(
      `pools report DIFFERENT postmaster start times (different clusters): ${describe(
        (o) => o.postmasterStartedAt
      )}`
    );
  }
  const clusterIds = observed
    .map(([, o]) => o.observedClusterIdentifier)
    .filter((id): id is string => id !== null);
  if (new Set(clusterIds).size > 1) {
    fail(
      `pools report DIFFERENT cluster system identifiers: ${describe(
        (o) => o.observedClusterIdentifier ?? 'unavailable'
      )}`
    );
  }

  const first = observed[0]![1];
  const database = first.database;
  if (RESET_TARGET_DENYLIST.has(database)) {
    fail(`live current_database() is "${database}" (denylisted)`);
  }
  if (database !== SHOWROOM_TARGET_DB && !SHOWROOM_TEST_TARGET_RE.test(database)) {
    fail(`live current_database() is "${database}", not a dedicated showroom database`);
  }

  const identity: ShowroomLiveDatabaseIdentity = {
    database,
    serverAddress: first.serverAddress,
    serverPort: first.serverPort,
    postmasterStartedAt: first.postmasterStartedAt,
  };
  // Presente SOLO cuando los cinco roles lo observaron (unanime).
  if (clusterIds.length === SHOWROOM_DB_ROLES.length) {
    identity.clusterIdentifier = clusterIds[0];
  }
  return identity;
}

/**
 * UNICO productor del handle verificado: attestation live completa sobre los
 * cinco pools. El plan (cuando el flujo venia del guard puro de URLs) debe ser
 * coherente con lo observado en vivo — la URL jamas es la unica evidencia.
 */
export async function verifyShowroomTarget(
  env: string,
  pools: ShowroomPools,
  options: { plan?: ShowroomTargetPlan | null } = {}
): Promise<VerifiedShowroomTarget> {
  if (env !== 'local' && env !== 'test') throw new ShowroomEnvironmentError(env);
  const identity = await observeShowroomLiveIdentity(pools);
  const plan = options.plan ?? null;
  if (plan && plan.targetDbName !== identity.database) {
    fail(
      `planned target "${plan.targetDbName}" does not match live current_database() "${identity.database}"`
    );
  }
  const target: VerifiedShowroomTarget = Object.freeze({
    pools,
    identity,
    plan,
    [VERIFIED_BRAND]: true,
  }) as VerifiedShowroomTarget;
  VERIFIED_TARGETS.add(target);
  return target;
}

/** Validacion runtime del handle: pools planos/casts/copias se rechazan. */
export function assertVerifiedShowroomTarget(
  target: unknown
): asserts target is VerifiedShowroomTarget {
  if (
    target === null ||
    typeof target !== 'object' ||
    !VERIFIED_TARGETS.has(target) ||
    (target as Record<PropertyKey, unknown>)[VERIFIED_BRAND] !== true
  ) {
    throw new ShowroomUnverifiedTargetError();
  }
}

/**
 * Re-attestation TOCTOU: inmediatamente antes de mirar contenido, la identidad
 * live ACTUAL debe coincidir con la atestiguada en el handle. Una attestation
 * antigua no basta si los pools fueron reemplazados o el endpoint cambio de
 * cluster (p. ej. otro servidor escuchando en el mismo puerto).
 */
export async function reattestVerifiedShowroomTarget(
  target: VerifiedShowroomTarget
): Promise<void> {
  const now = await observeShowroomLiveIdentity(target.pools);
  const attested = target.identity;
  const drift: string[] = [];
  if (now.database !== attested.database) drift.push('database');
  if (now.serverAddress !== attested.serverAddress) drift.push('serverAddress');
  if (now.serverPort !== attested.serverPort) drift.push('serverPort');
  if (now.postmasterStartedAt !== attested.postmasterStartedAt) drift.push('postmasterStartedAt');
  if (
    attested.clusterIdentifier !== undefined &&
    now.clusterIdentifier !== attested.clusterIdentifier
  ) {
    drift.push('clusterIdentifier');
  }
  if (drift.length > 0) {
    fail(
      `live identity changed since attestation (${drift.join(', ')}): the target is no longer the attested cluster/database`
    );
  }
}
