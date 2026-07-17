import { loadConfig } from '@fluvia/config';
import {
  RESET_CONFIRMATION,
  ShowroomResetGuardError,
  ShowroomResetSequenceError,
  assertShowroomResetAllowed,
  runShowroomReset,
  showroomUrlsFromEnv,
} from './reset.js';
import {
  SHOWROOM,
  ShowroomAlreadySeededError,
  ShowroomEnvironmentError,
  ShowroomSeedError,
  type ShowroomSeedResult,
} from './showroom.js';

/**
 * CLI: `pnpm demo:reset -- --confirm RESET_FLUVIA_SHOWROOM`
 *
 * DESTRUCTIVO: DROP/CREATE de la base DEDICADA del showroom (fluvia_showroom)
 * y reconstruccion completa (migrate -> seedShowroom -> invariantes [1]-[9] ->
 * manifiesto). JAMAS toca la base principal `fluvia` ni `postgres`/template*.
 *
 * Configuracion (variables PROPIAS; defaults SOLO en local/test):
 *   SHOWROOM_ADMIN_DATABASE_URL / SHOWROOM_APP_DATABASE_URL /
 *   SHOWROOM_AUTH_DATABASE_URL / SHOWROOM_RELAY_DATABASE_URL /
 *   SHOWROOM_WEBHOOK_DATABASE_URL  -> TODAS hacia el MISMO dbname target.
 *   SHOWROOM_MAINTENANCE_DATABASE_URL -> conexion de MANTENIMIENTO separada
 *   (allowlist: solo la base `postgres`; nunca puede ser el target del DROP).
 */

const KNOWN_ERRORS = [
  ShowroomResetGuardError,
  ShowroomResetSequenceError,
  ShowroomEnvironmentError,
  ShowroomAlreadySeededError,
  ShowroomSeedError,
];

// eslint-disable-next-line no-console
const say = (msg: string) => console.log(msg);

function parseConfirm(argv: string[]): string | undefined {
  const idx = argv.indexOf('--confirm');
  if (idx !== -1) return argv[idx + 1];
  const eq = argv.find((a) => a.startsWith('--confirm='));
  return eq?.slice('--confirm='.length);
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  say(`demo:reset — reset DESTRUCTIVO de la base dedicada del showroom.

Uso:
  pnpm demo:reset -- --confirm ${RESET_CONFIRMATION}

Solo entorno local/test. Target permitido: fluvia_showroom (o
fluvia_showroom_test_<id> en integracion automatizada). La conexion de
mantenimiento es SHOWROOM_MAINTENANCE_DATABASE_URL (base postgres, separada).`);
  process.exit(0);
}

const config = loadConfig();
const urls = showroomUrlsFromEnv();
const confirm = parseConfirm(process.argv.slice(2));

function printSandboxMaterial(result: ShowroomSeedResult): void {
  say(`
================ CREDENCIALES SANDBOX (se muestran UNA sola vez) ================
  ENTORNO: SANDBOX — dinero simulado, credenciales SOLO de demo local.
  Usuarios sandbox:
${result.sandbox.users.map((u) => `    ${u.email} / ${u.password}  [${u.role}]`).join('\n')}
  API key sandbox (mode test) — secreto irrecuperable despues de esta linea:
    ${result.sandbox.apiKey.label}: ${result.sandbox.apiKey.secret}
==================================================================================`);
}

try {
  // Guard PURO por adelantado (sin conexiones) solo para poder anunciar el
  // target exacto; runShowroomReset lo re-ejecuta como primera fase.
  const plan = assertShowroomResetAllowed({
    env: config.env,
    confirm,
    targetUrls: urls.targetUrls,
    maintenanceUrl: urls.maintenanceUrl,
  });
  say(`demo:reset (SANDBOX, DESTRUCTIVO)
  target:       ${plan.targetDbName} (DROP DATABASE + CREATE DATABASE)
  maintenance:  ${plan.maintenanceDbName} (${plan.host}:${plan.port})
  secuencia:    guard -> drop/create -> migrate -> seed -> invariantes -> manifiesto`);

  const result = await runShowroomReset(
    { env: config.env, confirm, targetUrls: urls.targetUrls, maintenanceUrl: urls.maintenanceUrl },
    {
      onPhase: (phase) => say(`  fase ${phase}`),
      onSeedPhase: (phase) =>
        say(
          phase === 'await-expiry'
            ? '    seed await-expiry: esperando la expiracion NORMATIVA del checkout (TTL minimo 5 min)…'
            : `    seed ${phase}`
        ),
    }
  );

  say(`
Reset del showroom COMPLETO sobre "${result.targetDbName}":
  organizacion  ${SHOWROOM.organizationName}
  merchant      ${SHOWROOM.merchantName} (${SHOWROOM.currency})
  invariantes   [1]-[9] ${result.invariants}
  manifiesto    version ${result.manifest.manifestVersion} (semantico, sin IDs/secretos/timestamps)`);
  printSandboxMaterial(result.seed);
} catch (err) {
  if (KNOWN_ERRORS.some((k) => err instanceof k)) {
    // Errores esperados (guard incluido): mensaje estable, sin stack.
    console.error(`demo:reset fallo: ${(err as Error).message}`);
  } else {
    console.error(err);
  }
  process.exitCode = 1;
}
