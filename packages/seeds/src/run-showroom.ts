import { loadConfig } from '@fluvia/config';
import {
  ShowroomSeedGuardError,
  createShowroomSeedPools,
  showroomUrlsFromEnv,
  type ShowroomSeedPoolSet,
} from './reset.js';
import {
  SHOWROOM,
  ShowroomAlreadySeededError,
  ShowroomDatabaseMismatchError,
  ShowroomEnvironmentError,
  ShowroomSeedError,
  seedShowroom,
  type ShowroomSeedResult,
} from './showroom.js';

/**
 * CLI: `pnpm showroom:seed` — puebla la base DEDICADA del showroom
 * (`fluvia_showroom`, ya migrada y VACIA) via servicios normativos.
 *
 * El guard PURO del target (assertShowroomSeedTargetAllowed, via
 * createShowroomSeedPools) corre ANTES de crear cualquier pool, conexion o
 * query y ANTES de imprimir nada que afirme que el target es valido: unas
 * SHOWROOM_*_DATABASE_URL explicitas apuntando a `fluvia` (o a cualquier base
 * no dedicada) abortan aqui con cero efectos. Dentro de `seedShowroom` hay
 * ademas una defensa LIVE (`current_database()` por pool).
 *
 * Si la base ya tiene datos del showroom, el seed falla closed e indica
 * ejecutar `pnpm demo:reset -- --confirm RESET_FLUVIA_SHOWROOM`.
 * Las credenciales SANDBOX se muestran UNA sola vez y SOLO tras el exito.
 */

const KNOWN_ERRORS = [
  ShowroomSeedGuardError,
  ShowroomEnvironmentError,
  ShowroomDatabaseMismatchError,
  ShowroomAlreadySeededError,
  ShowroomSeedError,
];

// eslint-disable-next-line no-console
const say = (msg: string) => console.log(msg);

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

const config = loadConfig();
const urls = showroomUrlsFromEnv();

// Guard PURO primero: si rechaza, no existe ningun pool que cerrar.
let opened: ShowroomSeedPoolSet;
try {
  opened = createShowroomSeedPools(config.env, urls.targetUrls);
} catch (err) {
  if (err instanceof ShowroomSeedGuardError) {
    console.error(`showroom:seed fallo: ${err.message}`);
    process.exit(1);
  }
  throw err;
}
const { plan, pools } = opened;

say(
  `Seed del showroom (SANDBOX) sobre la base dedicada "${plan.targetDbName}" (env=${config.env})…`
);

try {
  const result = await seedShowroom(config.env, pools, {
    onPhase: (phase) => {
      if (phase === 'await-expiry') {
        say(
          '  fase await-expiry: esperando la expiracion NORMATIVA de la sesion de checkout (TTL minimo del servicio: 5 min)…'
        );
      } else {
        say(`  fase ${phase}`);
      }
    },
  });
  say(`
Showroom sembrado (org "${SHOWROOM.organizationName}", merchant "${SHOWROOM.merchantName}", moneda ${SHOWROOM.currency}).
Re-ejecutar sobre la misma base ABORTA sin mutar: reconstruye con demo:reset.`);
  printSandboxMaterial(result);
} catch (err) {
  if (KNOWN_ERRORS.some((k) => err instanceof k)) {
    // Errores esperados: mensaje estable, sin stack.
    console.error(`showroom:seed fallo: ${(err as Error).message}`);
  } else {
    console.error(err);
  }
  process.exitCode = 1;
} finally {
  await Promise.all([
    pools.admin.end(),
    pools.app.end(),
    pools.auth.end(),
    pools.relay.end(),
    pools.webhook.end(),
  ]);
}
