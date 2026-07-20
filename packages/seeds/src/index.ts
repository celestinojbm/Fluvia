export { seedUuid } from './deterministic.js';
export {
  DEMO,
  SeedEnvironmentError,
  seedDemo,
  type DemoUserSpec,
  type SeedPools,
  type SeedReport,
} from './seed.js';
export {
  SHOWROOM,
  SHOWROOM_EXPECTED_BALANCES,
  ShowroomAlreadySeededError,
  ShowroomDatabaseMismatchError,
  ShowroomEnvironmentError,
  ShowroomSeedError,
  seedShowroom,
  type ShowroomPhase,
  type ShowroomPools,
  type ShowroomSandboxMaterial,
  type ShowroomSeedOptions,
  type ShowroomSeedResult,
} from './showroom.js';
// NOTA (RA-F65C3-EXT-001): el accessor interno `getVerifiedShowroomTargetState`
// NO se reexporta aqui a proposito — el estado privado del handle (snapshot de
// pools/identidad/plan) solo es alcanzable dentro del paquete.
export {
  ShowroomUnverifiedTargetError,
  assertVerifiedShowroomTarget,
  observeShowroomLiveIdentity,
  reattestVerifiedShowroomTarget,
  verifyShowroomTarget,
  type ClusterIdentifierEvidence,
  type ShowroomLiveDatabaseIdentity,
  type ShowroomRole,
  type VerifiedShowroomTarget,
} from './live-identity.js';
export { formatSafeShowroomCliError, type ShowroomCliName } from './cli-errors.js';
export { runShowroomSeedCli, type ShowroomSeedCliDeps } from './run-showroom.js';
export { runShowroomResetCli, type ShowroomResetCliDeps } from './run-reset.js';
export {
  buildShowroomSemanticManifest,
  serializeShowroomManifest,
  type ManifestEntityState,
  type ShowroomSemanticManifest,
} from './manifest.js';
export {
  MAINTENANCE_DB_ALLOWLIST,
  RESET_CONFIRMATION,
  RESET_TARGET_DENYLIST,
  SHOWROOM_DB_ROLES,
  SHOWROOM_TARGET_DB,
  SHOWROOM_TEST_TARGET_RE,
  ShowroomResetGuardError,
  ShowroomResetSequenceError,
  ShowroomSeedGuardError,
  ShowroomTargetRemovedError,
  TUPLE_CONCURRENTLY_UPDATED_MESSAGE,
  TUPLE_CONCURRENTLY_UPDATED_SQLSTATE,
  assertShowroomResetAllowed,
  assertShowroomSeedTargetAllowed,
  isRetryableTupleConcurrentlyUpdated,
  openShowroomPoolsSafely,
  openVerifiedShowroomTarget,
  prepareShowroomDatabase,
  runShowroomReset,
  showroomUrlsFromEnv,
  type ShowroomDbUrls,
  type ShowroomEnvUrls,
  type ShowroomOpenedTarget,
  type ShowroomResetDeps,
  type ShowroomResetGuardCode,
  type ShowroomResetPhase,
  type ShowroomResetPlan,
  type ShowroomResetRequest,
  type ShowroomResetResult,
  type ShowroomSeedGuardCode,
  type ShowroomSeedTargetRequest,
  type ShowroomTargetPlan,
} from './reset.js';
