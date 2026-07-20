import { pathToFileURL } from 'node:url';
import { loadConfig as realLoadConfig } from '@fluvia/config';
import { formatSafeShowroomCliError } from './cli-errors.js';
import {
  openVerifiedShowroomTarget,
  showroomUrlsFromEnv,
  type ShowroomOpenedTarget,
} from './reset.js';
import { SHOWROOM, seedShowroom, type ShowroomSeedResult } from './showroom.js';

/**
 * CLI: `pnpm showroom:seed` — puebla la base DEDICADA del showroom
 * (`fluvia_showroom`, ya migrada y VACIA) via servicios normativos.
 *
 * Flujo autorizado (RA-F65C3-EXT-001): guard PURO de URLs -> apertura SEGURA
 * de pools -> attestation LIVE de identidad unica -> handle verificado ->
 * seedShowroom (que re-atestigua TOCTOU sobre el snapshot privado).
 *
 * FRONTERA SANITIZADA COMPLETA (RA-F65C3-EXT-006): TODO el bootstrap —
 * loadConfig, lectura de env/argv, showroomUrlsFromEnv, guard, pools,
 * attestation, seed, impresion final y cleanup — corre DENTRO de
 * `runShowroomSeedCli`, que jamas deja escapar una excepcion: cualquier fallo
 * (conocido o desconocido, incluso del propio bootstrap) sale por
 * `formatSafeShowroomCliError` como UNA linea segura y exit code 1. El modulo
 * ejecutable solo hace `process.exitCode = await runShowroomSeedCli()`.
 *
 * Las credenciales SANDBOX se muestran UNA sola vez y SOLO tras el exito.
 */

export interface ShowroomSeedCliDeps {
  loadConfig?: typeof realLoadConfig;
  urlsFromEnv?: typeof showroomUrlsFromEnv;
  openTarget?: typeof openVerifiedShowroomTarget;
  seed?: typeof seedShowroom;
  log?: (line: string) => void;
  error?: (line: string) => void;
}

function printSandboxMaterial(say: (line: string) => void, result: ShowroomSeedResult): void {
  say(`
================ CREDENCIALES SANDBOX (se muestran UNA sola vez) ================
  ENTORNO: SANDBOX — dinero simulado, credenciales SOLO de demo local.
  Usuarios sandbox:
${result.sandbox.users.map((u) => `    ${u.email} / ${u.password}  [${u.role}]`).join('\n')}
  API key sandbox (mode test) — secreto irrecuperable despues de esta linea:
    ${result.sandbox.apiKey.label}: ${result.sandbox.apiKey.secret}
==================================================================================`);
}

export async function runShowroomSeedCli(deps: ShowroomSeedCliDeps = {}): Promise<number> {
  // eslint-disable-next-line no-console
  const say = deps.log ?? ((line: string) => console.log(line));
  const errOut = deps.error ?? ((line: string) => console.error(line));
  let phase = 'startup';
  let opened: ShowroomOpenedTarget | undefined;
  let exitCode = 0;
  try {
    const config = (deps.loadConfig ?? realLoadConfig)();
    const urls = (deps.urlsFromEnv ?? showroomUrlsFromEnv)();

    // Guard puro -> pools seguros -> attestation live -> handle. Si CUALQUIER
    // paso rechaza, no queda ningun pool abierto y no se ha impreso nada que
    // afirme un target valido.
    opened = await (deps.openTarget ?? openVerifiedShowroomTarget)(config.env, urls.targetUrls);

    say(
      `Seed del showroom (SANDBOX) sobre la base dedicada "${opened.targetDbName}" (env=${config.env}, identidad live atestiguada)…`
    );

    phase = 'preflight';
    const result = await (deps.seed ?? seedShowroom)(config.env, opened.target, {
      onPhase: (p) => {
        phase = p;
        if (p === 'await-expiry') {
          say(
            '  fase await-expiry: esperando la expiracion NORMATIVA de la sesion de checkout (TTL minimo del servicio: 5 min)…'
          );
        } else {
          say(`  fase ${p}`);
        }
      },
    });
    say(`
Showroom sembrado (org "${SHOWROOM.organizationName}", merchant "${SHOWROOM.merchantName}", moneda ${SHOWROOM.currency}).
Re-ejecutar sobre la misma base ABORTA sin mutar: reconstruye con demo:reset.`);
    printSandboxMaterial(say, result);
  } catch (err) {
    errOut(formatSafeShowroomCliError('showroom:seed', err, phase));
    exitCode = 1;
  } finally {
    if (opened !== undefined) {
      try {
        await opened.close();
      } catch {
        errOut('showroom:seed cleanup warning [pool_close_failed]');
      }
    }
  }
  return exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runShowroomSeedCli();
}
