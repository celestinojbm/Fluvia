import { loadConfig } from '@fluvia/config';
import { createPool } from '@fluvia/db';
import { showroomUrlsFromEnv } from './reset.js';
import {
  SHOWROOM,
  ShowroomAlreadySeededError,
  ShowroomEnvironmentError,
  ShowroomSeedError,
  seedShowroom,
  type ShowroomSeedResult,
} from './showroom.js';

/**
 * CLI: `pnpm showroom:seed` — puebla la base DEDICADA del showroom
 * (`fluvia_showroom`, ya migrada y VACIA) via servicios normativos.
 *
 * Si la base ya tiene datos del showroom, el seed falla closed e indica
 * ejecutar `pnpm demo:reset -- --confirm RESET_FLUVIA_SHOWROOM`.
 * Las credenciales SANDBOX se muestran UNA sola vez y SOLO tras el exito.
 */

const KNOWN_ERRORS = [ShowroomEnvironmentError, ShowroomAlreadySeededError, ShowroomSeedError];

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
const targetDbName = new URL(urls.targetUrls.admin).pathname.slice(1);

say(`Seed del showroom (SANDBOX) sobre la base dedicada "${targetDbName}" (env=${config.env})…`);

const admin = createPool({ connectionString: urls.targetUrls.admin, max: 4 });
const app = createPool({ connectionString: urls.targetUrls.app, max: 8 });
const auth = createPool({ connectionString: urls.targetUrls.auth, max: 2 });
const relay = createPool({ connectionString: urls.targetUrls.relay, max: 2 });
const webhook = createPool({ connectionString: urls.targetUrls.webhook, max: 2 });

try {
  const result = await seedShowroom(
    config.env,
    { admin, app, auth, relay, webhook },
    {
      onPhase: (phase) => {
        if (phase === 'await-expiry') {
          say(
            '  fase await-expiry: esperando la expiracion NORMATIVA de la sesion de checkout (TTL minimo del servicio: 5 min)…'
          );
        } else {
          say(`  fase ${phase}`);
        }
      },
    }
  );
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
  await Promise.all([admin.end(), app.end(), auth.end(), relay.end(), webhook.end()]);
}
