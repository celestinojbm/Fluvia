import { pathToFileURL } from 'node:url';
import { loadConfig as realLoadConfig } from '@fluvia/config';
import { renderSingleFailureLine, safeWrite } from './cli-errors.js';
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
 * FRONTERA SANITIZADA COMPLETA (RA-F65C3-EXT-006, delta 3): TODO el bootstrap
 * corre dentro de `runShowroomSeedCli`, que JAMAS deja escapar una excepcion
 * — ni siquiera si el WRITER inyectado (stderr/stdout, EPIPE, Proxy hostil)
 * lanza. Todo output pasa por `safeWrite`. Un fallo produce EXACTAMENTE UNA
 * linea segura por stderr (primario + cleanup fallido = una linea con el
 * sufijo fijo `[pool_close_failed]`, jamas dos). Las credenciales SANDBOX se
 * imprimen UNA sola vez, SOLO tras el exito Y tras el cierre LIMPIO de los
 * pools: un cleanup fallido suprime las credenciales y sale con 1.
 */

export interface ShowroomSeedCliDeps {
  loadConfig?: typeof realLoadConfig;
  urlsFromEnv?: typeof showroomUrlsFromEnv;
  openTarget?: typeof openVerifiedShowroomTarget;
  seed?: typeof seedShowroom;
  log?: (line: string) => void;
  error?: (line: string) => void;
}

function sandboxMaterialBlock(result: ShowroomSeedResult): string {
  return `
================ CREDENCIALES SANDBOX (se muestran UNA sola vez) ================
  ENTORNO: SANDBOX — dinero simulado, credenciales SOLO de demo local.
  Usuarios sandbox:
${result.sandbox.users.map((u) => `    ${u.email} / ${u.password}  [${u.role}]`).join('\n')}
  API key sandbox (mode test) — secreto irrecuperable despues de esta linea:
    ${result.sandbox.apiKey.label}: ${result.sandbox.apiKey.secret}
==================================================================================`;
}

export async function runShowroomSeedCli(deps: ShowroomSeedCliDeps = {}): Promise<number> {
  // Catch FINAL fail-closed: el cuerpo de abajo ya no deberia poder lanzar
  // (todo output via safeWrite, todo error capturado), pero si CUALQUIER cosa
  // escapara, el contrato se mantiene: exit 1, sin imprimir el error crudo.
  try {
    // eslint-disable-next-line no-console
    const say = deps.log ?? ((line: string) => console.log(line));
    const errOut = deps.error ?? ((line: string) => console.error(line));
    let phase = 'startup';
    let opened: ShowroomOpenedTarget | undefined;
    let result: ShowroomSeedResult | undefined;
    let hasPrimary = false;
    let primaryError: unknown;
    try {
      const config = (deps.loadConfig ?? realLoadConfig)();
      const urls = (deps.urlsFromEnv ?? showroomUrlsFromEnv)();

      // Guard puro -> pools seguros -> attestation live -> handle. Si
      // CUALQUIER paso rechaza, no queda ningun pool abierto y no se ha
      // impreso nada que afirme un target valido.
      opened = await (deps.openTarget ?? openVerifiedShowroomTarget)(config.env, urls.targetUrls);

      safeWrite(
        say,
        `Seed del showroom (SANDBOX) sobre la base dedicada "${opened.targetDbName}" (env=${config.env}, identidad live atestiguada)…`
      );

      phase = 'preflight';
      result = await (deps.seed ?? seedShowroom)(config.env, opened.target, {
        onPhase: (p) => {
          phase = p;
          safeWrite(
            say,
            p === 'await-expiry'
              ? '  fase await-expiry: esperando la expiracion NORMATIVA de la sesion de checkout (TTL minimo del servicio: 5 min)…'
              : `  fase ${p}`
          );
        },
      });
    } catch (err) {
      hasPrimary = true;
      primaryError = err;
    }

    // Cleanup SIEMPRE, y ANTES de imprimir cualquier exito: las credenciales
    // solo existen si el cierre de pools tambien fue limpio.
    let cleanupFailed = false;
    if (opened !== undefined) {
      try {
        await opened.close();
      } catch {
        cleanupFailed = true;
      }
    }

    if (hasPrimary || cleanupFailed) {
      safeWrite(
        errOut,
        renderSingleFailureLine('showroom:seed', hasPrimary, primaryError, cleanupFailed, phase)
      );
      return 1;
    }

    const success = `
Showroom sembrado (org "${SHOWROOM.organizationName}", merchant "${SHOWROOM.merchantName}", moneda ${SHOWROOM.currency}).
Re-ejecutar sobre la misma base ABORTA sin mutar: reconstruye con demo:reset.${sandboxMaterialBlock(result!)}`;
    if (!safeWrite(say, success)) {
      // El writer de exito fallo: las credenciales pueden no haber llegado al
      // operador — se reporta con UNA linea fija y exit 1 (jamas se reintenta
      // la impresion del secreto).
      safeWrite(errOut, 'showroom:seed output write failed [output_write_failed]');
      return 1;
    }
    return 0;
  } catch {
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runShowroomSeedCli();
}
