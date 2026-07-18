import { loadConfig } from '@fluvia/config';
import { formatSafeShowroomCliError } from './cli-errors.js';
import type { VerifiedShowroomTarget } from './live-identity.js';
import { openVerifiedShowroomTarget, showroomUrlsFromEnv } from './reset.js';
import { SHOWROOM, seedShowroom, type ShowroomSeedResult } from './showroom.js';

/**
 * CLI: `pnpm showroom:seed` — puebla la base DEDICADA del showroom
 * (`fluvia_showroom`, ya migrada y VACIA) via servicios normativos.
 *
 * Flujo autorizado (RA-F65C3-EXT-001): guard PURO de URLs (antes de crear
 * cualquier pool/conexion/query y antes de imprimir nada que afirme un target
 * valido) -> apertura SEGURA de pools (fallo parcial => cierre de los ya
 * creados) -> attestation LIVE de identidad unica del cluster
 * (current_database + endpoint del servidor + arranque del postmaster +
 * system_identifier, por CADA rol) -> handle verificado -> seedShowroom.
 *
 * Si la base ya tiene datos del showroom, el seed falla closed e indica
 * ejecutar `pnpm demo:reset -- --confirm RESET_FLUVIA_SHOWROOM`.
 * Las credenciales SANDBOX se muestran UNA sola vez y SOLO tras el exito.
 * Cualquier error DESCONOCIDO se imprime SANITIZADO (sin objeto, sin stack,
 * sin cause, sin URLs ni secretos) via formatSafeShowroomCliError.
 */

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

// Guard puro -> pools seguros -> attestation live -> handle. Si CUALQUIER
// paso rechaza, no queda ningun pool abierto (la apertura segura y la
// attestation cierran lo que hubieran abierto) y no se ha impreso nada que
// afirme un target valido.
let target: VerifiedShowroomTarget;
try {
  target = await openVerifiedShowroomTarget(config.env, urls.targetUrls);
} catch (err) {
  console.error(formatSafeShowroomCliError('showroom:seed', err, 'startup'));
  process.exit(1);
}

say(
  `Seed del showroom (SANDBOX) sobre la base dedicada "${target.identity.database}" (env=${config.env}, identidad live atestiguada)…`
);

let lastPhase = 'preflight';
try {
  const result = await seedShowroom(config.env, target, {
    onPhase: (phase) => {
      lastPhase = phase;
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
  console.error(formatSafeShowroomCliError('showroom:seed', err, lastPhase));
  process.exitCode = 1;
} finally {
  const pools = target.pools;
  await Promise.all([
    pools.admin.end(),
    pools.app.end(),
    pools.auth.end(),
    pools.relay.end(),
    pools.webhook.end(),
  ]);
}
