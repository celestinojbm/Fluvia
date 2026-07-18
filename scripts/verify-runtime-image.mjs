#!/usr/bin/env node
/* global process, console */
/**
 * F6.5C3 / RA-F65C3-EXT-002+EXT-007 — verificador REPRODUCIBLE de la imagen
 * runtime: construye el Dockerfile EXACTO del repo (`-f Dockerfile`,
 * `--target runtime`) y demuestra, sobre el ARTEFACTO OCI real, que el
 * tooling del showroom no viaja en NINGUNA capa de la imagen final (no basta
 * con que el filesystem merged no lo muestre: un `rm` posterior a un COPY
 * dejaria el codigo recuperable en la capa inferior).
 *
 * Uso:
 *   pnpm runtime:image:verify
 *
 * Entorno (opcional):
 *   FLUVIA_BUILD_CA_FILE  ruta LOCAL de una CA para egress TLS interceptado;
 *                         se pasa como BuildKit secret (id=fluvia_build_ca):
 *                         vive solo durante los RUN que la montan, jamas en
 *                         una capa/ENV/history. Sin la variable, build normal.
 *   FLUVIA_BUILD_NETWORK  valor para `docker build --network` (p. ej. `host`
 *                         cuando el proxy de egress escucha en loopback).
 *
 * Comprobaciones (falla con exit != 0 si cualquiera no se cumple):
 *   1. build real del Dockerfile exacto, target runtime;
 *   2. image ID + USER node + CMD del API + ENV sin NODE_EXTRA_CA_CERTS;
 *   3. filesystem MERGED (contenedor creado sin iniciar + docker export):
 *      sin rutas prohibidas, sin symlinks hacia seeds, API y worker presentes,
 *      scripts prohibidos ausentes del package.json runtime;
 *   4. TODAS las capas del manifiesto (docker save + tar de cada layer):
 *      sin rutas prohibidas, sin symlinks hacia seeds, sin whiteouts de seeds,
 *      sin package.json de workspace con scripts prohibidos, sin restos de
 *      /run/secrets;
 *   5. el package.json del CHECKOUT conserva los tres scripts locales;
 *   6. cleanup total (contenedor, tar, imagen temporal) incluso ante fallo.
 *
 * Solo Node standard library + binarios `docker` y `tar`. Distingue metadata
 * EJECUTABLE real (rutas de archivos, symlinks, scripts de package.json) de
 * referencias textuales inocuas en documentacion: jamas hace grep ciego del
 * contenido de archivos.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// Helpers PUROS (testeados por packages/seeds/test/runtime-image-verifier.ts)
// ---------------------------------------------------------------------------

export const FORBIDDEN_SCRIPTS = ['seed', 'showroom:seed', 'demo:reset'];
const FORBIDDEN_BASENAMES = new Set(['run-reset.ts', 'run-showroom.ts', 'showroom.ts']);

/** Normaliza una ruta de entrada tar ('./x', '/x', 'x/') a 'x'. */
export function normalizeTarPath(path) {
  return String(path).replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
}

/**
 * true si la RUTA (no el contenido) corresponde a tooling del showroom que la
 * imagen final no puede contener: el directorio packages/seeds, cualquier
 * referencia @fluvia/seeds, los CLIs/nucleo del showroom por basename, el
 * manifest.ts del showroom (solo bajo una ruta seeds) y whiteouts OCI de
 * seeds (señal del patron inseguro COPY+rm).
 */
export function isForbiddenImagePath(path) {
  const p = normalizeTarPath(path);
  if (p === '') return false;
  if (/(^|\/)packages\/seeds(\/|$)/.test(p)) return true;
  if (/(^|\/)@fluvia\/seeds(\/|$)/.test(p)) return true;
  const base = p.split('/').pop() ?? '';
  if (FORBIDDEN_BASENAMES.has(base)) return true;
  if (base === 'manifest.ts' && /(^|\/)seeds(\/|$)/.test(p)) return true;
  if (base.startsWith('.wh.') && /seeds/.test(base)) return true;
  return false;
}

/** true si un symlink apunta (textual) hacia el tooling de seeds. */
export function isForbiddenLinkTarget(target) {
  const t = String(target ?? '');
  return t.includes('packages/seeds') || t.includes('@fluvia/seeds');
}

/**
 * Parsea la salida de `tar -tv` a entradas { type, path, linkTarget }.
 * type: '-' fichero, 'd' dir, 'l' symlink, 'h' hardlink…
 */
export function parseTarListing(listing) {
  const entries = [];
  for (const raw of String(listing).split('\n')) {
    const line = raw.trimEnd();
    if (line === '') continue;
    const m = /^([-dlhbcps])\S*\s+\S+\s+\d+\s+\S+(?:\s+\S+)?\s+(.+)$/.exec(line);
    if (!m) continue;
    const type = m[1];
    let path = m[2];
    let linkTarget = null;
    if (type === 'l') {
      const arrow = path.lastIndexOf(' -> ');
      if (arrow !== -1) {
        linkTarget = path.slice(arrow + 4);
        path = path.slice(0, arrow);
      }
    } else if (type === 'h') {
      const link = path.lastIndexOf(' link to ');
      if (link !== -1) {
        linkTarget = path.slice(link + 9);
        path = path.slice(0, link);
      }
    }
    entries.push({ type, path: normalizeTarPath(path), linkTarget });
  }
  return entries;
}

/**
 * package.json de WORKSPACE dentro de la imagen (raiz /app, apps/*,
 * packages/*), excluyendo node_modules: SOLO ahi un script `seed`/
 * `demo:reset` seria tooling ejecutable nuestro (un package.json de una
 * dependencia con un script "seed" propio no es nuestro tooling — no se hace
 * grep ciego).
 */
export function isWorkspaceManifestPath(path) {
  const p = normalizeTarPath(path);
  if (p.includes('node_modules/')) return false;
  return /^app\/(package\.json|(apps|packages)\/[^/]+\/package\.json)$/.test(p);
}

/** Scripts prohibidos presentes como scripts EJECUTABLES de un package.json. */
export function forbiddenScriptsIn(pkgJsonText) {
  let pkg;
  try {
    pkg = JSON.parse(String(pkgJsonText));
  } catch {
    return [];
  }
  const scripts = pkg && typeof pkg === 'object' ? (pkg.scripts ?? {}) : {};
  return FORBIDDEN_SCRIPTS.filter((s) => Object.prototype.hasOwnProperty.call(scripts, s));
}

/** Escanea entradas tar: devuelve la lista de violaciones (vacia = limpio). */
export function scanEntries(entries, label) {
  const violations = [];
  for (const e of entries) {
    if (isForbiddenImagePath(e.path)) {
      violations.push(`${label}: forbidden path ${e.path}`);
    }
    if (e.linkTarget !== null && isForbiddenLinkTarget(e.linkTarget)) {
      violations.push(`${label}: symlink ${e.path} -> ${e.linkTarget}`);
    }
    if (/^run\/secrets(\/|$)/.test(e.path)) {
      violations.push(`${label}: /run/secrets residue ${e.path}`);
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Ejecutor (solo cuando se invoca como script)
// ---------------------------------------------------------------------------

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ['ignore', opts.capture ? 'pipe' : 'inherit', 'inherit'],
      env: { ...process.env, DOCKER_BUILDKIT: '1' },
    });
    let out = '';
    if (opts.capture) child.stdout.on('data', (d) => (out += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`));
    });
  });
}

/**
 * Pipeline `a | b` via `sh -c` con argumentos POSICIONALES (jamas
 * interpolacion de strings): el pipe es NATIVO del shell, asi que cuando el
 * consumidor termina (p. ej. `tar -tv` se detiene en el end-of-archive), el
 * productor recibe el cierre del pipe y muere solo — sin procesos colgados
 * (encadenar los streams a traves de Node deja al productor bloqueado
 * escribiendo el padding final contra un extremo que Node retiene abierto).
 * El contenido capturado decide, no el exit code (el productor puede terminar
 * con EPIPE benigno tras servir lo pedido).
 */
function shPipe(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', script, 'sh', ...args], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', reject);
    child.on('close', () => resolve(out));
  });
}

async function main() {
  const caFile = process.env.FLUVIA_BUILD_CA_FILE;
  const network = process.env.FLUVIA_BUILD_NETWORK;
  const tag = `fluvia-runtime-verify-${process.pid}`;
  const work = mkdtempSync(join(tmpdir(), 'fluvia-runtime-verify-'));
  let containerId = '';
  const violations = [];
  const say = (m) => console.log(`[runtime:image:verify] ${m}`);

  try {
    // 1) Build CANONICO: el Dockerfile exacto del repo.
    const buildArgs = ['build', '-f', 'Dockerfile', '--target', 'runtime', '-t', tag];
    if (network) buildArgs.push('--network', network);
    if (caFile) buildArgs.push('--secret', `id=fluvia_build_ca,src=${caFile}`);
    buildArgs.push('.');
    say(`docker ${buildArgs.map((a) => (a === caFile ? a : a)).join(' ')}`);
    await run('docker', buildArgs);

    // 2) Config de la imagen.
    const inspect = JSON.parse(await run('docker', ['image', 'inspect', tag], { capture: true }));
    const image = inspect[0];
    const imageId = image.Id;
    const user = image.Config.User;
    const cmd = JSON.stringify(image.Config.Cmd);
    const env = image.Config.Env ?? [];
    say(`image ${imageId}`);
    if (user !== 'node') violations.push(`USER is "${user}", expected "node"`);
    if (cmd !== JSON.stringify(['pnpm', '--filter', '@fluvia/api', 'start'])) {
      violations.push(`CMD is ${cmd}`);
    }
    for (const e of env) {
      if (e.startsWith('NODE_EXTRA_CA_CERTS=')) {
        violations.push(`image ENV leaks ${e.split('=')[0]}`);
      }
    }

    // 3) Filesystem MERGED: contenedor creado SIN iniciar + docker export.
    containerId = (await run('docker', ['create', tag], { capture: true })).trim();
    const mergedListing = await shPipe('docker export "$1" | tar -tv -f -', [containerId]);
    const mergedEntries = parseTarListing(mergedListing);
    violations.push(...scanEntries(mergedEntries, 'merged'));
    const mergedPaths = new Set(mergedEntries.map((e) => e.path));
    for (const required of [
      'app/apps/api/package.json',
      'app/apps/worker/package.json',
      'app/package.json',
    ]) {
      if (!mergedPaths.has(required)) violations.push(`merged: missing ${required}`);
    }
    say(`merged filesystem entries: ${mergedEntries.length}`);

    const runtimeRootPkg = await shPipe('docker export "$1" | tar -xO -f - app/package.json', [
      containerId,
    ]);
    const leaked = forbiddenScriptsIn(runtimeRootPkg);
    if (leaked.length > 0) violations.push(`merged app/package.json declares: ${leaked.join(',')}`);

    // 4) TODAS las capas del manifiesto de la imagen final.
    const imageTar = join(work, 'image.tar');
    await run('docker', ['save', '-o', imageTar, tag]);
    const manifestText = await shPipe('tar -xO -f "$1" manifest.json', [imageTar]);
    const manifest = JSON.parse(manifestText)[0];
    const layers = manifest.Layers;
    say(`layers in final image manifest: ${layers.length}`);
    let inspected = 0;
    for (const layer of layers) {
      const layerListing = await listNestedLayer(imageTar, layer);
      const entries = parseTarListing(layerListing);
      // FAIL-CLOSED: toda layer real contiene al menos una entrada; un listado
      // vacio significa que NO pudo leerse (compresion inesperada, formato
      // nuevo) y jamas puede contar como "limpia".
      if (entries.length === 0) {
        violations.push(`layer ${layer}: unreadable or empty listing (fail-closed)`);
      }
      violations.push(...scanEntries(entries, `layer ${layer}`));
      for (const e of entries) {
        if (isWorkspaceManifestPath(e.path) && e.type === '-') {
          const content = await readNestedLayerFile(imageTar, layer, e.path);
          const bad = forbiddenScriptsIn(content);
          if (bad.length > 0) {
            violations.push(`layer ${layer}: ${e.path} declares ${bad.join(',')}`);
          }
        }
      }
      inspected++;
    }
    say(`layers inspected: ${inspected}/${layers.length}`);

    // 5) El package.json del CHECKOUT conserva los scripts locales.
    const repoPkg = readFileSync('package.json', 'utf8');
    const kept = forbiddenScriptsIn(repoPkg);
    if (kept.length !== FORBIDDEN_SCRIPTS.length) {
      violations.push(`checkout package.json lost local scripts (has: ${kept.join(',')})`);
    }

    if (violations.length > 0) {
      for (const v of violations) console.error(`[runtime:image:verify] VIOLATION: ${v}`);
      process.exitCode = 1;
      say('FAIL');
    } else {
      say('OK: runtime image is free of showroom tooling in merged fs AND every layer');
      say(`summary: image=${imageId} user=${user} cmd=${cmd} layers=${layers.length}`);
    }
  } finally {
    // 6) Cleanup SIEMPRE (contenedor, tar temporal, imagen), incluso ante fallo.
    if (containerId) {
      await run('docker', ['rm', '-f', containerId], { capture: true }).catch(() => undefined);
    }
    await run('docker', ['rmi', '-f', tag], { capture: true }).catch(() => undefined);
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Lista (tar -tv) una layer anidada del docker save SIN extraer a disco.
 * Las layers pueden venir gzip-comprimidas (media type OCI) o planas: `gzip
 * -dcf` descomprime las primeras y deja pasar las segundas SIN cambios (la
 * autodeteccion de tar solo funciona sobre archivos, no sobre stdin).
 */
async function listNestedLayer(imageTar, layerMember) {
  return shPipe('tar -xO -f "$1" "$2" | gzip -dcf | tar -tv -f -', [imageTar, layerMember]);
}

/** Extrae UN archivo de una layer anidada, a memoria. */
async function readNestedLayerFile(imageTar, layerMember, filePath) {
  return shPipe('tar -xO -f "$1" "$2" | gzip -dcf | tar -xO -f - "$3"', [
    imageTar,
    layerMember,
    filePath,
  ]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`[runtime:image:verify] ERROR: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  });
}
