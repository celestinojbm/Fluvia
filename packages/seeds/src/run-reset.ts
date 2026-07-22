import { pathToFileURL } from 'node:url';
import { loadConfig as realLoadConfig } from '@fluvia/config';
import { renderSingleFailureLine, safeWrite } from './cli-errors.js';
import {
  RESET_CONFIRMATION,
  assertShowroomResetAllowed,
  runShowroomReset,
  showroomUrlsFromEnv,
} from './reset.js';
import { SHOWROOM, type ShowroomSeedResult } from './showroom.js';

/**
 * CLI: `pnpm demo:reset -- --confirm RESET_FLUVIA_SHOWROOM`
 *
 * DESTRUCTIVO: DROP/CREATE de la base DEDICADA del showroom (fluvia_showroom)
 * y reconstruccion completa (migrate -> attestation -> seedShowroom ->
 * invariantes [1]-[9] -> manifiesto). JAMAS toca la base principal `fluvia`
 * ni `postgres`/template*.
 *
 * FRONTERA SANITIZADA COMPLETA (RA-F65C3-EXT-006, delta 3): TODO el bootstrap
 * corre dentro de `runShowroomResetCli`, que JAMAS deja escapar una excepcion
 * — ni siquiera si el WRITER inyectado lanza (EPIPE, Proxy hostil, string).
 * Todo output pasa por `safeWrite`; cualquier fallo produce EXACTAMENTE UNA
 * linea segura por stderr y exit 1. Los recursos externos del reset (pools,
 * maintenance) los cierra `runShowroomReset` internamente con timeouts duros
 * ANTES de devolver: cuando este CLI imprime las credenciales SANDBOX, el
 * cleanup ya termino limpio (un cleanup fallido emerge como error tipado y
 * suprime el bloque de exito).
 *
 * Configuracion (variables PROPIAS; defaults SOLO en local/test):
 *   SHOWROOM_ADMIN_DATABASE_URL / SHOWROOM_APP_DATABASE_URL /
 *   SHOWROOM_AUTH_DATABASE_URL / SHOWROOM_RELAY_DATABASE_URL /
 *   SHOWROOM_WEBHOOK_DATABASE_URL  -> TODAS hacia el MISMO dbname target.
 *   SHOWROOM_MAINTENANCE_DATABASE_URL -> conexion de MANTENIMIENTO separada
 *   (allowlist: solo la base `postgres`; nunca puede ser el target del DROP).
 */

export interface ShowroomResetCliDeps {
  loadConfig?: typeof realLoadConfig;
  urlsFromEnv?: typeof showroomUrlsFromEnv;
  runReset?: typeof runShowroomReset;
  argv?: readonly string[];
  log?: (line: string) => void;
  error?: (line: string) => void;
}

function parseConfirm(argv: readonly string[]): string | undefined {
  const idx = argv.indexOf('--confirm');
  if (idx !== -1) return argv[idx + 1];
  const eq = argv.find((a) => a.startsWith('--confirm='));
  return eq?.slice('--confirm='.length);
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

export async function runShowroomResetCli(deps: ShowroomResetCliDeps = {}): Promise<number> {
  // Catch FINAL fail-closed: exit 1 sin imprimir el error crudo, aunque nada
  // del cuerpo deberia poder lanzar (output via safeWrite, errores capturados).
  try {
    // eslint-disable-next-line no-console
    const say = deps.log ?? ((line: string) => console.log(line));
    const errOut = deps.error ?? ((line: string) => console.error(line));
    let phase = 'startup';
    try {
      const argv = deps.argv ?? process.argv.slice(2);
      if (argv.includes('--help') || argv.includes('-h')) {
        safeWrite(
          say,
          `demo:reset — reset DESTRUCTIVO de la base dedicada del showroom.

Uso:
  pnpm demo:reset -- --confirm ${RESET_CONFIRMATION}

Solo entorno local/test. Target permitido: fluvia_showroom (o
fluvia_showroom_test_<id> en integracion automatizada). La conexion de
mantenimiento es SHOWROOM_MAINTENANCE_DATABASE_URL (base postgres, separada).`
        );
        return 0;
      }

      const config = (deps.loadConfig ?? realLoadConfig)();
      const urls = (deps.urlsFromEnv ?? showroomUrlsFromEnv)();
      const confirm = parseConfirm(argv);

      // Guard PURO por adelantado (sin conexiones) solo para poder anunciar el
      // target exacto; runShowroomReset lo re-ejecuta como primera fase.
      phase = 'guard';
      const plan = assertShowroomResetAllowed({
        env: config.env,
        confirm,
        targetUrls: urls.targetUrls,
        maintenanceUrl: urls.maintenanceUrl,
      });
      safeWrite(
        say,
        `demo:reset (SANDBOX, DESTRUCTIVO)
  target:       ${plan.targetDbName} (DROP DATABASE + CREATE DATABASE)
  maintenance:  ${plan.maintenanceDbName} (${plan.host}:${plan.port})
  secuencia:    guard -> drop/create -> migrate -> seed -> invariantes -> manifiesto`
      );

      const result = await (deps.runReset ?? runShowroomReset)(
        {
          env: config.env,
          confirm,
          targetUrls: urls.targetUrls,
          maintenanceUrl: urls.maintenanceUrl,
        },
        {
          onPhase: (p) => {
            phase = p;
            safeWrite(say, `  fase ${p}`);
          },
          onSeedPhase: (p) => {
            phase = p;
            safeWrite(
              say,
              p === 'await-expiry'
                ? '    seed await-expiry: esperando la expiracion NORMATIVA del checkout (TTL minimo 5 min)…'
                : `    seed ${p}`
            );
          },
        }
      );

      // Exito: el cleanup interno del reset ya termino LIMPIO (un fallo de
      // cierre habria emergido como ShowroomResetSequenceError tipado).
      const success = `
Reset del showroom COMPLETO sobre "${result.targetDbName}":
  organizacion  ${SHOWROOM.organizationName}
  merchant      ${SHOWROOM.merchantName} (${SHOWROOM.currency})
  invariantes   [1]-[9] ${result.invariants}
  manifiesto    version ${result.manifest.manifestVersion} (semantico, sin IDs/secretos/timestamps)${sandboxMaterialBlock(result.seed)}`;
      if (!safeWrite(say, success)) {
        safeWrite(errOut, 'demo:reset output write failed [output_write_failed]');
        return 1;
      }
      return 0;
    } catch (err) {
      // Conocidos: plantilla FIJA. Desconocidos: linea generica. SIEMPRE una
      // sola linea, incluso si el writer de stderr tambien falla.
      safeWrite(errOut, renderSingleFailureLine('demo:reset', true, err, false, phase));
      return 1;
    }
  } catch {
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runShowroomResetCli();
}
