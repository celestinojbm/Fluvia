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
 * servidor real. La identidad se observa read-only:
 *
 *  - `current_database()`        -> nombre real de la base (dedicada, denylist);
 *  - `inet_server_addr()`        -> direccion LOCAL del servidor (NULL en
 *                                   sockets Unix => rechazo);
 *  - `inet_server_port()`        -> puerto real del servidor;
 *  - `pg_postmaster_start_time()`-> instante de arranque del postmaster;
 *  - `pg_control_system().system_identifier` -> identificador ESTABLE del
 *    cluster. La evidencia se conserva de forma DISCRIMINADA (delta EXT-001):
 *    `complete` (los cinco lo observaron) / `partial` (al menos uno lo observo
 *    y al menos uno recibio EXACTAMENTE 42501) / `none` (los cinco recibieron
 *    42501). Un identifier observado JAMAS se descarta por ser parcial; todo
 *    identifier observado debe tener formato valido y coincidir con el resto;
 *    cualquier error distinto de 42501 aborta.
 *
 * ESTADO VERIFICADO PRIVADO E INMUTABLE (delta EXT-001): el handle publico
 * `VerifiedShowroomTarget` es OPACO — no expone pools, identidad, plan, Symbol
 * ni accessor. El estado real vive en un WeakMap PRIVADO de este modulo, con
 * un SNAPSHOT NUEVO y CONGELADO del mapping de pools (claves exactas
 * admin/app/auth/relay/webhook) copiado en `verifyShowroomTarget`: mutar el
 * objeto de pools ORIGINAL despues de crear el handle no cambia el target —
 * la re-attestation y todos los servicios usan exclusivamente el snapshot
 * privado. `getVerifiedShowroomTargetState` es el accessor INTERNO del paquete
 * (reset/seed/CLI) y NO se reexporta en `packages/seeds/src/index.ts`.
 */

export type ShowroomRole = (typeof SHOWROOM_DB_ROLES)[number];

/**
 * Evidencia DISCRIMINADA del system_identifier del cluster dentro de una
 * attestation (jamas se mezclan ausencia, respuesta invalida y 42501: una
 * respuesta invalida o un error distinto de 42501 abortan la attestation).
 */
export type ClusterIdentifierEvidence =
  | { mode: 'none'; observingRoles: readonly [] }
  | { mode: 'partial' | 'complete'; value: string; observingRoles: readonly ShowroomRole[] };

export interface ShowroomLiveDatabaseIdentity {
  /** current_database() — identico en los cinco roles y dedicado. */
  database: string;
  /** inet_server_addr() — jamas null (exige endpoint TCP observable). */
  serverAddress: string;
  /** inet_server_port() — jamas null. */
  serverPort: number;
  /** pg_postmaster_start_time()::text — coincide exactamente entre roles. */
  postmasterStartedAt: string;
  /** Evidencia discriminada del system_identifier (ver arriba). */
  clusterEvidence: ClusterIdentifierEvidence;
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

/**
 * Handle runtime OPACO: solo `verifyShowroomTarget` produce uno valido. NO
 * expone pools, identidad, plan, estado, WeakMap, Symbol ni accessor publico:
 * su unica propiedad es una etiqueta informativa constante.
 */
export interface VerifiedShowroomTarget {
  readonly kind: 'verified-showroom-target';
}

/** Estado privado e inmutable de un handle verificado (jamas exportado). */
interface InternalVerifiedTargetState {
  readonly pools: Readonly<{
    admin: Pool;
    app: Pool;
    auth: Pool;
    relay: Pool;
    webhook: Pool;
  }>;
  readonly identity: ShowroomLiveDatabaseIdentity;
  readonly plan: ShowroomTargetPlan | null;
}

/**
 * Autoridad runtime PRIVADA y UNICA: el WeakMap (una copia `{ ...handle }` o
 * un `Object.create(handle)` no estan en el map). El handle NO lleva ninguna
 * marca propia — ni Symbol ni token — para no exponer nada reutilizable.
 */
const TARGET_STATE = new WeakMap<object, InternalVerifiedTargetState>();

const TIMESTAMPTZ_TEXT_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{2}(:?\d{2})?$/;
const CLUSTER_IDENTIFIER_RE = /^\d{1,32}$/;

interface IdentityRow {
  database: unknown;
  server_address: unknown;
  server_port: unknown;
  postmaster_started_at: unknown;
}

const IDENTITY_SQL = `SELECT current_database() AS database,
       host(inet_server_addr()) AS server_address,
       inet_server_port()::text AS server_port,
       pg_postmaster_start_time()::text AS postmaster_started_at`;

const CLUSTER_SQL = `SELECT system_identifier::text AS cluster_identifier FROM pg_control_system()`;

interface ObservedIdentity {
  database: string;
  serverAddress: string;
  serverPort: number;
  postmasterStartedAt: string;
  /** null <=> este rol recibio EXACTAMENTE 42501 al leer pg_control_system(). */
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

  // system_identifier: la UNICA ausencia legitima es EXACTAMENTE 42501
  // (insufficient_privilege). Una respuesta invalida o cualquier otro error
  // abortan — jamas se confunden con "no observable".
  let observedClusterIdentifier: string | null = null;
  try {
    const res = await pool.query<{ cluster_identifier: unknown }>(CLUSTER_SQL);
    const id = res.rows[0]?.cluster_identifier;
    if (typeof id !== 'string' || !CLUSTER_IDENTIFIER_RE.test(id)) {
      fail(`pool "${role}": pg_control_system() returned an unexpected system_identifier`);
    }
    observedClusterIdentifier = id;
  } catch (err) {
    if (err instanceof ShowroomDatabaseMismatchError) throw err;
    if ((err as { code?: unknown }).code !== '42501') {
      fail(`pool "${role}": pg_control_system() query failed (${(err as Error).name ?? 'error'})`);
    }
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
 * Observa y CONSOLIDA la identidad live de los cinco pools: misma base
 * dedicada, mismo endpoint (addr+port), mismo arranque de postmaster, y
 * evidencia discriminada del system_identifier (todo identifier observado debe
 * coincidir; `none` SOLO si los cinco recibieron exactamente 42501).
 */
export async function observeShowroomLiveIdentity(
  pools: ShowroomPools
): Promise<ShowroomLiveDatabaseIdentity> {
  const observed: Array<[ShowroomRole, ObservedIdentity]> = [];
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

  const observingRoles = observed
    .filter(([, o]) => o.observedClusterIdentifier !== null)
    .map(([role]) => role);
  const observedIds = new Set(
    observed.map(([, o]) => o.observedClusterIdentifier).filter((id): id is string => id !== null)
  );
  if (observedIds.size > 1) {
    fail(
      `pools report DIFFERENT cluster system identifiers: ${describe(
        (o) => o.observedClusterIdentifier ?? 'unavailable'
      )}`
    );
  }
  // Evidencia DISCRIMINADA: un identifier observado por ALGUNOS roles se
  // CONSERVA como `partial` (jamas se descarta); `none` solo si los cinco
  // recibieron exactamente 42501.
  const clusterEvidence: ClusterIdentifierEvidence =
    observingRoles.length === 0
      ? Object.freeze({ mode: 'none' as const, observingRoles: Object.freeze([]) as readonly [] })
      : Object.freeze({
          mode:
            observingRoles.length === SHOWROOM_DB_ROLES.length
              ? ('complete' as const)
              : ('partial' as const),
          value: [...observedIds][0]!,
          observingRoles: Object.freeze([...observingRoles]),
        });

  const first = observed[0]![1];
  const database = first.database;
  if (RESET_TARGET_DENYLIST.has(database)) {
    fail(`live current_database() is "${database}" (denylisted)`);
  }
  if (database !== SHOWROOM_TARGET_DB && !SHOWROOM_TEST_TARGET_RE.test(database)) {
    fail(`live current_database() is "${database}", not a dedicated showroom database`);
  }

  return Object.freeze({
    database,
    serverAddress: first.serverAddress,
    serverPort: first.serverPort,
    postmasterStartedAt: first.postmasterStartedAt,
    clusterEvidence,
  });
}

/**
 * Compara la identidad atestiguada con una observacion fresca como UNA sola
 * identidad (address, port, postmaster, dbname y evidencia de identifier).
 * Transiciones de evidencia (fail-closed, jamas degradacion silenciosa):
 *  - inicial con valor X: todo identifier nuevo observado debe ser X (Y =>
 *    rechazo); perder TODA observabilidad (`none`) => rechazo; perder algun
 *    rol observador previo => rechazo explicito (el conjunto fresco debe
 *    CONTENER al inicial; ganar observabilidad partial->complete es valido).
 *  - inicial `none`: debe conservarse `none`; la aparicion posterior de un
 *    identifier es un CAMBIO de evidencia => rechazo fail-closed (no se
 *    implementa ninguna transicion autenticada adicional).
 */
function assertSameIdentity(
  attested: ShowroomLiveDatabaseIdentity,
  fresh: ShowroomLiveDatabaseIdentity
): void {
  const drift: string[] = [];
  if (fresh.database !== attested.database) drift.push('database');
  if (fresh.serverAddress !== attested.serverAddress) drift.push('serverAddress');
  if (fresh.serverPort !== attested.serverPort) drift.push('serverPort');
  if (fresh.postmasterStartedAt !== attested.postmasterStartedAt) {
    drift.push('postmasterStartedAt');
  }

  const a = attested.clusterEvidence;
  const f = fresh.clusterEvidence;
  if (a.mode === 'none') {
    if (f.mode !== 'none') drift.push('clusterEvidence(none->observed)');
  } else {
    if (f.mode === 'none') {
      drift.push('clusterEvidence(observability lost)');
    } else {
      if (f.value !== a.value) drift.push('clusterIdentifier');
      const freshRoles = new Set<ShowroomRole>(f.observingRoles);
      const lost = a.observingRoles.filter((role) => !freshRoles.has(role));
      if (lost.length > 0) {
        drift.push(`clusterEvidence(observing roles lost: ${lost.join('/')})`);
      }
    }
  }

  if (drift.length > 0) {
    fail(
      `live identity changed since attestation (${drift.join(', ')}): the target is no longer the attested cluster/database`
    );
  }
}

/**
 * UNICO productor del handle verificado: attestation live completa sobre los
 * cinco pools. Copia el mapping de pools en un SNAPSHOT NUEVO y CONGELADO
 * (claves exactas admin/app/auth/relay/webhook) — el objeto recibido del
 * caller no se almacena ni se vuelve a usar jamas: mutarlo despues no cambia
 * el target. El plan (cuando el flujo venia del guard puro de URLs) debe ser
 * coherente con lo observado en vivo.
 */
export async function verifyShowroomTarget(
  env: string,
  pools: ShowroomPools,
  options: { plan?: ShowroomTargetPlan | null } = {}
): Promise<VerifiedShowroomTarget> {
  if (env !== 'local' && env !== 'test') throw new ShowroomEnvironmentError(env);
  // SNAPSHOT primero (una sola lectura de cada rol del objeto del caller):
  // la attestation y todo uso posterior operan SOLO sobre el snapshot.
  const snapshot = Object.freeze({
    admin: pools.admin,
    app: pools.app,
    auth: pools.auth,
    relay: pools.relay,
    webhook: pools.webhook,
  });
  const identity = await observeShowroomLiveIdentity(snapshot);
  const plan = options.plan ?? null;
  if (plan && plan.targetDbName !== identity.database) {
    fail(
      `planned target "${plan.targetDbName}" does not match live current_database() "${identity.database}"`
    );
  }
  const target = Object.freeze({
    kind: 'verified-showroom-target' as const,
  }) as VerifiedShowroomTarget;
  TARGET_STATE.set(target, Object.freeze({ pools: snapshot, identity, plan }));
  return target;
}

/**
 * Accessor INTERNO del paquete (reset/seed/CLI): valida la autenticidad del
 * handle (WeakMap privado — copias/casts/fakes quedan fuera) y devuelve el
 * estado privado inmutable. NO se reexporta en `packages/seeds/src/index.ts`.
 */
export function getVerifiedShowroomTargetState(target: unknown): InternalVerifiedTargetState {
  if (target === null || typeof target !== 'object') {
    throw new ShowroomUnverifiedTargetError();
  }
  const state = TARGET_STATE.get(target);
  if (state === undefined) {
    throw new ShowroomUnverifiedTargetError();
  }
  return state;
}

/** Validacion runtime del handle: pools planos/casts/copias se rechazan. */
export function assertVerifiedShowroomTarget(
  target: unknown
): asserts target is VerifiedShowroomTarget {
  void getVerifiedShowroomTargetState(target);
}

/**
 * Re-attestation TOCTOU sobre el SNAPSHOT PRIVADO (jamas sobre un objeto del
 * caller): inmediatamente antes del preflight de datos, la identidad live
 * ACTUAL debe coincidir con la atestiguada como UNA sola identidad (endpoint +
 * postmaster + dbname + evidencia de identifier, con las transiciones
 * fail-closed documentadas en assertSameIdentity).
 */
export async function reattestVerifiedShowroomTarget(
  target: VerifiedShowroomTarget
): Promise<void> {
  const state = getVerifiedShowroomTargetState(target);
  const fresh = await observeShowroomLiveIdentity(state.pools);
  assertSameIdentity(state.identity, fresh);
}
