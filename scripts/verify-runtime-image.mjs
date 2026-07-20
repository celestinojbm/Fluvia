#!/usr/bin/env node
/* global process, console, Buffer, fetch, setTimeout, clearTimeout, AbortSignal */
/**
 * F6.5C3 / RA-F65C3-EXT-002+EXT-007 (segunda delta) — verificador FAIL-CLOSED
 * de la imagen runtime. Construye el Dockerfile EXACTO del repo
 * (`-f Dockerfile --target runtime`, jamas un Dockerfile temporal ni un
 * checkout modificado) y demuestra sobre el ARTEFACTO OCI real que el tooling
 * del showroom no viaja en NINGUNA capa: ni por ruta, ni renombrado (hash de
 * contenido), ni via hardlink/symlink, ni como copia bajo node_modules, ni
 * como source map, ni como metadata de package.json.
 *
 * Politica de procesos (delta EXT-002/EXT-007):
 *   - CERO pipelines de shell: procesos SEPARADOS + archivos temporales.
 *   - TODO exit status se comprueba; docker/tar no-cero = fallo del gate.
 *   - stdout/stderr acotados; timeout duro por proceso con kill del process
 *     group; timeout GLOBAL duro del verificador completo.
 *   - Docker ausente = fallo del gate (jamas skip, jamas condicion de CI).
 *   - salida vacia/truncada donde se esperaba contenido = fallo.
 *
 * Analisis del artefacto (fail-closed):
 *   - parser tar BINARIO propio en streaming: cada header de 512 bytes parsea
 *     (checksum incluido) o el analisis entero falla; typeflag desconocido =
 *     fallo; paths normalizados (sin `..` ni absolutos); symlinks JAMAS
 *     seguidos; hardlinks resueltos al hash de su destino; whiteouts
 *     identificados; una entrada invalida invalida el archivo COMPLETO.
 *   - capa gzip ilegible/vacia o manifest sin capas = fallo.
 *   - inventario SHA-256 de packages/seeds/src/** + package.json de seeds del
 *     CHECKOUT contra TODOS los archivos regulares bajo /app del merged y de
 *     CADA capa.
 *   - firmas SEMANTICAS por conjuncion (>=2 marcadores especificos distintos
 *     o pares DROP DATABASE+fluvia_showroom / demo:reset+showroom:seed) sobre
 *     archivos codigo/metadata bajo /app/{apps,packages,scripts,node_modules}.
 *   - package.json estricto: JSON invalido = fallo (jamas lista vacia),
 *     scripts no-objeto = fallo, scripts prohibidos = fallo, metadata que
 *     resuelva @fluvia/seeds = fallo.
 *   - CA de build (si FLUVIA_BUILD_CA_FILE): sus bytes/hash no aparecen en
 *     merged/capas/config/ENV ni en `docker history --no-trunc`.
 *   - CONTROL NEGATIVO real construido en el mismo run: imagen con COPY de un
 *     fixture destructivo + rm posterior (merged aparentemente limpio, capa
 *     inferior contaminada); el scanner DEBE detectarla o el gate falla.
 *   - smokes REALES: API y worker arrancan dentro de la imagen final contra
 *     el PG/Redis de test (readiness observable via HTTP; MODULE_NOT_FOUND o
 *     salida inmediata = fallo).
 *
 * Entorno (opcional, NO cambia la semantica del gate):
 *   FLUVIA_BUILD_CA_FILE  CA local para egress TLS interceptado (BuildKit
 *                         secret id=fluvia_build_ca; jamas en una capa).
 *   FLUVIA_BUILD_NETWORK  valor para `docker build --network`.
 *
 * Los logs no contienen URLs, passwords ni secretos (redaccion activa).
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createGunzip } from 'node:zlib';

// ---------------------------------------------------------------------------
// Constantes del contrato (testeadas por packages/seeds/test/)
// ---------------------------------------------------------------------------

export const FORBIDDEN_SCRIPTS = ['seed', 'showroom:seed', 'demo:reset'];

/** Marcadores semanticos ESPECIFICOS del tooling del showroom: un archivo
 * codigo/metadata bajo el alcance con >=2 marcadores DISTINTOS, o con un PAR
 * conjuntivo completo, es una copia (renombrada o no) del tooling. Jamas se
 * dispara por UNA sola palabra generica. */
export const SEMANTIC_MARKERS = [
  'RESET_FLUVIA_SHOWROOM',
  'SHOWROOM_MAINTENANCE_DATABASE_URL',
  'runShowroomReset',
  'target_removed_rebuild_required',
  'ShowroomTargetRemovedError',
];
export const SEMANTIC_PAIRS = [
  ['DROP DATABASE', 'fluvia_showroom'],
  ['demo:reset', 'showroom:seed'],
];

const FORBIDDEN_BASENAMES = new Set(['run-reset.ts', 'run-showroom.ts', 'showroom.ts']);

const CODE_METADATA_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.json',
  '.map',
  '.sql',
  '.sh',
  '.bash',
  '.yml',
  '.yaml',
]);

/** Limite de captura por archivo escaneable (fail-closed: excederlo es una
 * violacion de formato, no un skip silencioso). */
const CONTENT_CAPTURE_LIMIT = 64 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Helpers PUROS (importados por los tests de @fluvia/seeds)
// ---------------------------------------------------------------------------

export class TarFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TarFormatError';
  }
}

/**
 * Normaliza una ruta de entrada tar y la valida FAIL-CLOSED: rechaza rutas
 * absolutas y todo segmento `..` (TarFormatError). './x/' -> 'x'.
 */
export function normalizeTarPath(raw) {
  let p = String(raw);
  if (p.startsWith('/')) throw new TarFormatError(`absolute tar path: ${p}`);
  while (p.startsWith('./')) p = p.slice(2);
  p = p.replace(/\/+$/, '');
  if (p === '.') p = '';
  for (const segment of p.split('/')) {
    if (segment === '..') throw new TarFormatError(`path traversal in tar path: ${raw}`);
  }
  return p;
}

const TYPEFLAG_MAP = new Map([
  ['0', 'file'],
  ['\0', 'file'],
  ['7', 'file'], // contiguous: fichero regular a todos los efectos
  ['1', 'hardlink'],
  ['2', 'symlink'],
  ['5', 'dir'],
  ['3', 'special'], // char device
  ['4', 'special'], // block device
  ['6', 'special'], // fifo
]);

function parseOctal(buf, field) {
  const text = buf.toString('ascii').replace(/\0/g, ' ').trim();
  if (text === '') return 0;
  if (!/^[0-7 ]+$/.test(text)) {
    throw new TarFormatError(`non-octal ${field} field: ${JSON.stringify(text)}`);
  }
  return Number.parseInt(text.replace(/ /g, ''), 8);
}

function cString(buf) {
  const nul = buf.indexOf(0);
  return (nul === -1 ? buf : buf.subarray(0, nul)).toString('utf8');
}

/** Parsea registros pax `LEN key=value\n` (fail-closed). */
function parsePaxRecords(content) {
  const out = new Map();
  let offset = 0;
  while (offset < content.length) {
    const space = content.indexOf(0x20, offset);
    if (space === -1) throw new TarFormatError('pax record without length delimiter');
    const lenText = content.subarray(offset, space).toString('ascii');
    if (!/^\d+$/.test(lenText)) throw new TarFormatError(`pax record bad length: ${lenText}`);
    const recordLen = Number.parseInt(lenText, 10);
    if (recordLen <= 0 || offset + recordLen > content.length) {
      throw new TarFormatError('pax record length out of bounds');
    }
    const record = content.subarray(offset, offset + recordLen).toString('utf8');
    if (!record.endsWith('\n')) throw new TarFormatError('pax record missing newline');
    const eq = record.indexOf('=');
    if (eq === -1) throw new TarFormatError('pax record missing =');
    out.set(record.slice(lenText.length + 1, eq), record.slice(eq + 1, -1));
    offset += recordLen;
  }
  return out;
}

const CHUNK = 8 * 1024 * 1024;

function bufferReader(buf) {
  let pos = 0;
  return {
    remaining: () => buf.length - pos,
    read(len) {
      if (pos + len > buf.length) throw new TarFormatError('unexpected EOF in tar');
      const b = buf.subarray(pos, pos + len);
      pos += len;
      return b;
    },
  };
}

function fdReader(fd, size) {
  let pos = 0;
  return {
    remaining: () => size - pos,
    read(len) {
      if (pos + len > size) throw new TarFormatError('unexpected EOF in tar');
      const b = Buffer.alloc(len);
      let n = 0;
      while (n < len) {
        const r = readSync(fd, b, n, len - n, pos + n);
        if (r === 0) throw new TarFormatError('unexpected EOF in tar');
        n += r;
      }
      pos += len;
      return b;
    },
  };
}

/**
 * Nucleo del parser tar BINARIO fail-closed, en streaming sobre un reader.
 * Por cada entrada construye `{ type, path, linkTarget, size, sha256?,
 * content? }` (sha256 de TODO fichero regular; content solo si
 * `capture(path, size)`) y la entrega a `onEntry`. Lanza TarFormatError ante
 * CUALQUIER estructura invalida: checksum, campos no numericos, typeflag
 * desconocido, tamano fuera del archivo, paths absolutos o con `..`,
 * registro pax malformado, datos tras el terminador, EOF prematuro. Una
 * entrada invalida invalida el archivo COMPLETO (jamas se ignora).
 */
function scanTarCore(reader, capture, onEntry) {
  let pendingLongName;
  let pendingLongLink;
  let pendingPax;
  let globalPax = new Map();
  let sawTerminator = false;
  let count = 0;
  const isZeroBlock = (block) => block.every((b) => b === 0);

  while (reader.remaining() >= 512) {
    const header = reader.read(512);
    if (isZeroBlock(header)) {
      sawTerminator = true;
      while (reader.remaining() > 0) {
        const padLen = Math.min(reader.remaining(), CHUNK);
        if (!reader.read(padLen).every((b) => b === 0)) {
          throw new TarFormatError('non-zero data after tar terminator');
        }
      }
      break;
    }

    // Checksum: bytes del header con el campo checksum (148..156) en blanco.
    const stored = parseOctal(header.subarray(148, 156), 'checksum');
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i];
    if (sum !== stored) throw new TarFormatError('tar header checksum mismatch');

    const typeflag = String.fromCharCode(header[156]);
    const size = parseOctal(header.subarray(124, 136), 'size');
    const padded = Math.ceil(size / 512) * 512;
    if (reader.remaining() < padded) throw new TarFormatError('tar entry data out of bounds');

    const readData = () => {
      const data = reader.read(padded);
      return data.subarray(0, size);
    };

    if (typeflag === 'L') {
      pendingLongName = cString(readData());
      continue;
    }
    if (typeflag === 'K') {
      pendingLongLink = cString(readData());
      continue;
    }
    if (typeflag === 'x') {
      pendingPax = parsePaxRecords(readData());
      continue;
    }
    if (typeflag === 'g') {
      globalPax = new Map([...globalPax, ...parsePaxRecords(readData())]);
      continue;
    }

    const type = TYPEFLAG_MAP.get(typeflag);
    if (type === undefined) {
      throw new TarFormatError(`unknown tar typeflag ${JSON.stringify(typeflag)}`);
    }

    let name = cString(header.subarray(0, 100));
    const magicIsUstar =
      header.subarray(257, 262).toString('ascii') === 'ustar' && header[262] === 0;
    const prefix = magicIsUstar ? cString(header.subarray(345, 500)) : '';
    if (prefix !== '') name = `${prefix}/${name}`;
    if (pendingLongName !== undefined) name = pendingLongName;
    let linkname = cString(header.subarray(157, 257));
    if (pendingLongLink !== undefined) linkname = pendingLongLink;
    const pax = pendingPax ?? globalPax;
    if (pax.has('path')) name = pax.get('path');
    if (pax.has('linkpath')) linkname = pax.get('linkpath');
    pendingLongName = undefined;
    pendingLongLink = undefined;
    pendingPax = undefined;

    const path = normalizeTarPath(name);
    const entry = {
      type,
      path,
      linkTarget: type === 'symlink' || type === 'hardlink' ? linkname : null,
      size,
    };

    if (type === 'file') {
      const wantContent = capture(path, size);
      if (wantContent && size > CONTENT_CAPTURE_LIMIT) {
        throw new TarFormatError(`scannable file too large to scan: ${path}`);
      }
      const hash = createHash('sha256');
      if (wantContent) {
        const data = readData();
        hash.update(data);
        entry.content = Buffer.from(data);
      } else {
        // hash en chunks sin retener el contenido
        let left = size;
        while (left > 0) {
          const take = Math.min(left, CHUNK);
          hash.update(reader.read(take));
          left -= take;
        }
        const pad = padded - size;
        if (pad > 0) reader.read(pad);
      }
      entry.sha256 = hash.digest('hex');
    } else if (padded > 0) {
      reader.read(padded);
    }

    onEntry(entry);
    count++;
  }

  if (!sawTerminator && reader.remaining() > 0) {
    throw new TarFormatError('truncated tar: partial trailing block');
  }
  return count;
}

/**
 * Version PURA sobre Buffer (para tests): devuelve el array completo de
 * entradas (con content en las capturadas). Fail-closed via TarFormatError.
 */
export function parseTarEntries(buf, capture = () => false) {
  const entries = [];
  scanTarCore(bufferReader(buf), capture, (e) => entries.push(e));
  return entries;
}

/** Ruta EJECUTABLE prohibida por nombre (independiente del contenido). */
export function isForbiddenImagePath(path) {
  const p = String(path);
  if (p === '') return false;
  if (/(^|\/)packages\/seeds(\/|$)/.test(p)) return true;
  if (/(^|\/)@fluvia\/seeds(\/|$)/.test(p)) return true;
  const base = p.split('/').pop() ?? '';
  if (FORBIDDEN_BASENAMES.has(base)) return true;
  if (base === 'manifest.ts' && /(^|\/)seeds(\/|$)/.test(p)) return true;
  if (base.startsWith('.wh.') && /seeds/.test(base)) return true;
  return false;
}

/** true si un symlink/hardlink apunta (textual) hacia el tooling de seeds. */
export function isForbiddenLinkTarget(target) {
  const t = String(target ?? '');
  return t.includes('packages/seeds') || t.includes('@fluvia/seeds');
}

/** ¿La ruta entra en el alcance del scan semantico (delta)? */
export function isSemanticScanPath(path) {
  const p = String(path);
  if (!/^app\/(apps|packages|scripts|node_modules)\//.test(p)) return false;
  const base = p.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return false;
  return CODE_METADATA_EXTENSIONS.has(base.slice(dot).toLowerCase());
}

/**
 * Violacion por firma semantica: >=2 marcadores especificos DISTINTOS o un
 * par conjuntivo completo. Devuelve los marcadores implicados (vacio =
 * limpio). Jamas dispara por UNA sola palabra generica.
 */
export function semanticSignatureViolation(text) {
  const t = String(text);
  const found = SEMANTIC_MARKERS.filter((m) => t.includes(m));
  if (found.length >= 2) return found;
  for (const [a, b] of SEMANTIC_PAIRS) {
    if (t.includes(a) && t.includes(b)) return [`${a}+${b}`];
  }
  return [];
}

/**
 * Clase de un package.json dentro de la imagen:
 *  - 'workspace': manifiesto NUESTRO (raiz /app, apps/*, packages/*).
 *  - 'dependency': manifiesto PROPIO de un paquete npm bajo node_modules.
 *  - 'nested': cualquier otro package.json (fixtures de deps, etc.).
 *  - null: no es un package.json.
 */
export function manifestKindForPath(path) {
  const p = String(path);
  if (!p.endsWith('/package.json') && p !== 'package.json') return null;
  if (/^app\/(package\.json|(apps|packages)\/[^/]+\/package\.json)$/.test(p)) {
    return 'workspace';
  }
  const idx = p.lastIndexOf('node_modules/');
  if (idx !== -1) {
    const rest = p.slice(idx + 'node_modules/'.length).split('/');
    if (
      (rest.length === 2 && rest[1] === 'package.json') ||
      (rest.length === 3 && rest[0].startsWith('@') && rest[2] === 'package.json')
    ) {
      return 'dependency';
    }
    return 'nested';
  }
  return 'nested';
}

/**
 * Violaciones de UN package.json (fail-closed, jamas "lista vacia" por
 * error de parseo):
 *  - workspace/dependency: JSON invalido = violacion; `scripts` presente y no
 *    objeto = violacion; scripts prohibidos (solo workspace: un script `seed`
 *    PROPIO de una dependencia ajena no es nuestro tooling) = violacion;
 *    metadata que RESUELVA @fluvia/seeds (name/deps/workspaces/pnpm) =
 *    violacion.
 *  - nested (fixtures de terceros): la resolucion textual de @fluvia/seeds =
 *    violacion (un JSON roto de un fixture ajeno no es nuestro tooling).
 */
export function packageJsonViolations(rawText, path) {
  const kind = manifestKindForPath(path);
  if (kind === null) return [];
  const text = String(rawText);
  const violations = [];
  if (kind === 'nested') {
    if (text.includes('@fluvia/seeds')) {
      violations.push(`${path}: references @fluvia/seeds`);
    }
    return violations;
  }
  let pkg;
  try {
    pkg = JSON.parse(text);
  } catch {
    return [`${path}: invalid JSON in package.json (fail-closed)`];
  }
  if (pkg === null || typeof pkg !== 'object' || Array.isArray(pkg)) {
    return [`${path}: package.json is not an object (fail-closed)`];
  }
  if ('scripts' in pkg) {
    if (pkg.scripts === null || typeof pkg.scripts !== 'object' || Array.isArray(pkg.scripts)) {
      violations.push(`${path}: scripts is not an object (fail-closed)`);
    } else if (kind === 'workspace') {
      for (const s of FORBIDDEN_SCRIPTS) {
        if (Object.prototype.hasOwnProperty.call(pkg.scripts, s)) {
          violations.push(`${path}: declares forbidden script "${s}"`);
        }
      }
    }
  }
  if (pkg.name === '@fluvia/seeds') {
    violations.push(`${path}: package name is @fluvia/seeds`);
  }
  for (const field of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    const deps = pkg[field];
    if (deps === undefined) continue;
    if (deps !== null && typeof deps === 'object' && !Array.isArray(deps)) {
      if (Object.prototype.hasOwnProperty.call(deps, '@fluvia/seeds')) {
        violations.push(`${path}: ${field} resolves @fluvia/seeds`);
      }
    } else {
      violations.push(`${path}: ${field} is not an object (fail-closed)`);
    }
  }
  if (JSON.stringify(pkg.workspaces ?? null).includes('seeds')) {
    violations.push(`${path}: workspaces resolves seeds`);
  }
  if (JSON.stringify(pkg.pnpm ?? null).includes('@fluvia/seeds')) {
    violations.push(`${path}: pnpm metadata resolves @fluvia/seeds`);
  }
  return violations;
}

/** Redacta URLs y material sensible de cualquier texto destinado a logs. */
export function redactForLog(text) {
  return String(text)
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"']+/gi, '<redacted-url>')
    .replace(/password[^\s"']*/gi, '<redacted>');
}

/** Predicado de captura de contenido para el parser. */
export function shouldCaptureContent(path) {
  return isSemanticScanPath(path) || manifestKindForPath(path) !== null;
}

/**
 * Scanner ESTATEFUL de un tar (merged o capa). Cada entrada pasa por:
 * rutas/links prohibidos, residuos de /run/secrets, inventario de hashes de
 * seeds (hardlinks resueltos al hash de su destino; destino desconocido =
 * violacion fail-closed), firma semantica, package.json estricto y material
 * CA. PURO respecto a disco.
 */
export function createTarScanner(label, options = {}) {
  const { seedHashes = new Map(), caSha256 = null, caNeedle = null } = options;
  const violations = [];
  const hashByPath = new Map();
  const paths = new Set();
  let entryCount = 0;

  const onEntry = (e) => {
    entryCount++;
    paths.add(e.path);
    if (isForbiddenImagePath(e.path)) {
      violations.push(`${label}: forbidden path ${e.path}`);
    }
    if (e.linkTarget !== null && isForbiddenLinkTarget(e.linkTarget)) {
      violations.push(`${label}: link ${e.path} -> targets seeds tooling`);
    }
    if (/^run\/secrets(\/|$)/.test(e.path)) {
      violations.push(`${label}: /run/secrets residue ${e.path}`);
    }
    let contentHash = null;
    if (e.type === 'file') {
      contentHash = e.sha256;
      hashByPath.set(e.path, e.sha256);
    } else if (e.type === 'hardlink') {
      let target = e.linkTarget ?? '';
      try {
        target = normalizeTarPath(target);
      } catch {
        violations.push(`${label}: hardlink ${e.path} has invalid target (fail-closed)`);
        return;
      }
      const resolved = hashByPath.get(target);
      if (resolved === undefined) {
        violations.push(`${label}: hardlink ${e.path} -> unknown target (fail-closed)`);
      } else {
        contentHash = resolved;
        hashByPath.set(e.path, resolved);
      }
    }
    // (el inventario y la CA excluyen archivos vacios: el hash del archivo
    // vacio jamas esta en los mapas, asi que no hay colision trivial)
    if (contentHash !== null && e.path.startsWith('app/')) {
      const hit = seedHashes.get(contentHash);
      if (hit !== undefined) {
        violations.push(`${label}: ${e.path} content-hash matches checkout ${hit}`);
      }
      if (caSha256 !== null && contentHash === caSha256) {
        violations.push(`${label}: ${e.path} content-hash matches the build CA`);
      }
    }
    if (e.content !== undefined) {
      const text = e.content.toString('utf8');
      if (isSemanticScanPath(e.path)) {
        const hit = semanticSignatureViolation(text);
        if (hit.length > 0) {
          violations.push(`${label}: ${e.path} semantic signature [${hit.join(', ')}]`);
        }
      }
      for (const v of packageJsonViolations(text, e.path)) {
        violations.push(`${label}: ${v}`);
      }
      if (caNeedle !== null && text.includes(caNeedle)) {
        violations.push(`${label}: ${e.path} embeds build CA material`);
      }
      delete e.content; // liberar memoria: el scan de esta entrada ya corrio
    }
  };

  return {
    onEntry,
    violations,
    paths,
    entryCount: () => entryCount,
  };
}

/** Version funcional para tests: escanea una lista de entradas ya parseada. */
export function scanTarEntries(entries, label, options = {}) {
  const scanner = createTarScanner(label, options);
  for (const e of entries) scanner.onEntry(e);
  return scanner.violations;
}

// ---------------------------------------------------------------------------
// Ejecutor (solo cuando se invoca como script)
// ---------------------------------------------------------------------------

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, '..');
const GLOBAL_TIMEOUT_MS = 25 * 60_000;
const OUTPUT_LIMIT = 16 * 1024 * 1024;

const say = (m) => console.log(`[runtime:image:verify] ${m}`);

/**
 * Ejecuta UN proceso (sin shell, sin pipes) con timeout duro y kill del
 * process group entero. Exit != 0 => Error con stderr acotado y REDACTADO.
 * stdout/stderr acotados; overflow de stdout = fallo (salida truncada jamas
 * se analiza como completa). Devuelve { stdout, stderr }.
 */
function runFull(cmd, args, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd ?? REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DOCKER_BUILDKIT: '1' },
      detached: true,
    });
    let out = '';
    let errOut = '';
    let overflow = false;
    let settled = false;
    const killGroup = () => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killGroup();
      reject(new Error(`${cmd} ${args[0] ?? ''} timed out after ${timeoutMs}ms (group killed)`));
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      out += d;
      if (out.length > OUTPUT_LIMIT) {
        overflow = true;
        killGroup();
      }
    });
    child.stderr.on('data', (d) => {
      errOut += d;
      if (errOut.length > OUTPUT_LIMIT) errOut = errOut.slice(-OUTPUT_LIMIT);
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`${cmd} could not be spawned: ${err.code ?? 'unknown'} (fail-closed)`));
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (overflow) {
        reject(new Error(`${cmd} ${args[0] ?? ''} produced oversized output (fail-closed)`));
      } else if (code === 0) {
        resolve({ stdout: out, stderr: errOut });
      } else {
        const tail = redactForLog(errOut.split('\n').slice(-15).join('\n'));
        reject(
          new Error(
            `${cmd} ${args.slice(0, 3).join(' ')} exited ${code ?? `signal ${signal}`}\n${tail}`
          )
        );
      }
    });
  });
}

async function run(cmd, args, opts = {}) {
  return (await runFull(cmd, args, opts)).stdout;
}

/** gunzip (o copia literal si no es gzip) a archivo temporal, sin procesos. */
async function gunzipToFile(src, dest) {
  const fd = openSync(src, 'r');
  const head = Buffer.alloc(2);
  try {
    readSync(fd, head, 0, 2, 0);
  } finally {
    closeSync(fd);
  }
  const isGzip = head[0] === 0x1f && head[1] === 0x8b;
  if (isGzip) {
    await pipeline(createReadStream(src), createGunzip(), createWriteStream(dest));
  } else {
    await pipeline(createReadStream(src), createWriteStream(dest));
  }
  const size = statSync(dest).size;
  if (size === 0) throw new Error(`decompressed layer is EMPTY (fail-closed)`);
  return dest;
}

/** Escanea un tar EN DISCO en streaming con el scanner dado. */
function scanTarFileStreaming(tarPath, label, scanner) {
  const size = statSync(tarPath).size;
  if (size === 0) throw new Error(`${label}: empty tar (fail-closed)`);
  const fd = openSync(tarPath, 'r');
  try {
    return scanTarCore(fdReader(fd, size), shouldCaptureContent, scanner.onEntry);
  } catch (err) {
    throw err instanceof TarFormatError ? new Error(`${label}: ${err.message} (fail-closed)`) : err;
  } finally {
    closeSync(fd);
  }
}

/** Inventario SHA-256 del tooling del showroom en el CHECKOUT. */
function buildSeedContentInventory() {
  const inventory = new Map();
  const addFile = (abs, repoRel) => {
    const data = readFileSync(abs);
    if (data.length === 0) return; // el hash del archivo vacio colisiona con todo
    inventory.set(createHash('sha256').update(data).digest('hex'), repoRel);
  };
  const walk = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const r = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(abs, r);
      else if (entry.isFile()) addFile(abs, r);
    }
  };
  walk(join(REPO_ROOT, 'packages/seeds/src'), 'packages/seeds/src');
  addFile(join(REPO_ROOT, 'packages/seeds/package.json'), 'packages/seeds/package.json');
  if (inventory.size === 0) throw new Error('seed content inventory is empty (fail-closed)');
  return inventory;
}

/** docker save -> extraccion -> scan streaming de CADA capa del manifiesto. */
async function scanImageLayers(tag, work, label, scanOptions) {
  const saveTar = join(work, `${label}-save.tar`);
  await run('docker', ['save', '-o', saveTar, tag], { timeoutMs: 600_000 });
  const extractDir = join(work, `${label}-save`);
  mkdirSync(extractDir, { recursive: true });
  await run('tar', ['-xf', saveTar, '-C', extractDir], { timeoutMs: 600_000 });
  rmSync(saveTar, { force: true });

  const manifest = JSON.parse(readFileSync(join(extractDir, 'manifest.json'), 'utf8'))[0];
  const layers = manifest?.Layers;
  if (!Array.isArray(layers) || layers.length === 0) {
    throw new Error(`${label}: image manifest has no layers (fail-closed)`);
  }
  say(`manifest layers count: ${layers.length}`);

  const violations = [];
  let inspected = 0;
  for (const layer of layers) {
    const plainTar = join(work, `${label}-layer.tar`);
    await gunzipToFile(join(extractDir, layer), plainTar);
    const scanner = createTarScanner(`${label} layer ${layer}`, scanOptions);
    const count = scanTarFileStreaming(plainTar, `${label} layer ${layer}`, scanner);
    if (count === 0) {
      violations.push(`${label} layer ${layer}: empty/unreadable layer (fail-closed)`);
    }
    violations.push(...scanner.violations);
    rmSync(plainTar, { force: true });
    inspected++;
  }
  say(`layers inspected: ${inspected}/${layers.length}`);
  rmSync(extractDir, { recursive: true, force: true });
  return { violations, layerCount: layers.length };
}

/** docker export del contenedor (sin iniciar) -> scan streaming del merged. */
async function scanMergedFilesystem(tag, work, label, scanOptions) {
  const containerId = (await run('docker', ['create', tag], { timeoutMs: 60_000 })).trim();
  if (containerId === '') throw new Error('docker create returned empty id (fail-closed)');
  try {
    const mergedTar = join(work, `${label}-merged.tar`);
    await run('docker', ['export', '-o', mergedTar, containerId], { timeoutMs: 600_000 });
    const scanner = createTarScanner(`${label} merged`, scanOptions);
    const count = scanTarFileStreaming(mergedTar, `${label} merged`, scanner);
    if (count === 0) throw new Error(`${label}: merged export is empty (fail-closed)`);
    rmSync(mergedTar, { force: true });
    return { scanner, count };
  } finally {
    await run('docker', ['rm', '-f', containerId], { timeoutMs: 60_000 }).catch(() => undefined);
  }
}

function smokeEnvArgs() {
  const args = ['-e', 'NODE_ENV=test'];
  for (const name of [
    'ADMIN_DATABASE_URL',
    'APP_DATABASE_URL',
    'WORKER_DATABASE_URL',
    'RELAY_DATABASE_URL',
    'AUTH_DATABASE_URL',
    'INBOX_DATABASE_URL',
    'WEBHOOK_DATABASE_URL',
    'REDIS_URL',
  ]) {
    if (process.env[name]) args.push('-e', `${name}=${process.env[name]}`);
  }
  return args;
}

async function pollHttpOk(url, attempts, delayMs) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return true;
    } catch {
      // aun no listo
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

async function containerLogsCombined(container) {
  // docker logs escribe el stream del proceso repartido entre stdout y
  // stderr: se capturan AMBOS del propio proceso docker (sin pipelines).
  const { stdout, stderr } = await runFull('docker', ['logs', '--tail', '200', container], {
    timeoutMs: 30_000,
  }).catch(() => ({ stdout: '', stderr: '' }));
  return `${stdout}\n${stderr}`;
}

async function runSmoke(tag, what, containerName, extraArgs, readinessUrl, command) {
  await run('docker', ['rm', '-f', containerName], { timeoutMs: 30_000 }).catch(() => undefined);
  await run(
    'docker',
    [
      'run',
      '-d',
      '--name',
      containerName,
      '--network',
      'host',
      ...smokeEnvArgs(),
      ...extraArgs,
      tag,
      ...command,
    ],
    { timeoutMs: 60_000 }
  );
  const ready = await pollHttpOk(readinessUrl, 60, 1500);
  const running = (
    await run('docker', ['inspect', '-f', '{{.State.Running}}', containerName], {
      timeoutMs: 30_000,
    }).catch(() => 'false')
  ).trim();
  const logs = await containerLogsCombined(containerName);
  if (/MODULE_NOT_FOUND|Cannot find module|ERR_MODULE_NOT_FOUND/.test(logs)) {
    throw new Error(`${what} smoke: MODULE_NOT_FOUND inside the runtime image (fail-closed)`);
  }
  if (!ready || running !== 'true') {
    const tail = redactForLog(logs.split('\n').slice(-25).join('\n'));
    throw new Error(`${what} smoke FAILED (ready=${ready}, running=${running})\n${tail}`);
  }
}

async function main() {
  const startedAt = Date.now();
  const globalTimer = setTimeout(() => {
    console.error(`[runtime:image:verify] GLOBAL TIMEOUT after ${GLOBAL_TIMEOUT_MS}ms — FAIL`);
    process.exit(1);
  }, GLOBAL_TIMEOUT_MS);

  const caFile = process.env.FLUVIA_BUILD_CA_FILE;
  const network = process.env.FLUVIA_BUILD_NETWORK;
  const tag = `fluvia-runtime-verify-${process.pid}`;
  const negTag = `fluvia-runtime-verify-neg-${process.pid}`;
  const apiContainer = `fluvia-rtv-api-${process.pid}`;
  const workerContainer = `fluvia-rtv-worker-${process.pid}`;
  const work = mkdtempSync(join(tmpdir(), 'fluvia-rtv-'));
  const violations = [];
  let cleanupFailed = false;

  try {
    // 0) Docker OBLIGATORIO: su ausencia es un fallo del gate, jamas un skip.
    await run('docker', ['version', '--format', '{{.Server.Version}}'], { timeoutMs: 30_000 });
    say(`timeout configured: global=${GLOBAL_TIMEOUT_MS}ms`);

    // Inventario de contenido del tooling (checkout) y material CA opcional.
    const seedHashes = buildSeedContentInventory();
    say(`seed content inventory: ${seedHashes.size} files hashed from the checkout`);
    let caSha256 = null;
    let caNeedle = null;
    if (caFile) {
      const caBytes = readFileSync(caFile);
      if (caBytes.length === 0) throw new Error('FLUVIA_BUILD_CA_FILE is empty (fail-closed)');
      caSha256 = createHash('sha256').update(caBytes).digest('hex');
      // Aguja de 64 chars del cuerpo base64 del PEM: detecta el material
      // incrustado en texto sin volcar la CA a los logs.
      const body = caBytes
        .toString('utf8')
        .split('\n')
        .find((l) => /^[A-Za-z0-9+/=]{40,}$/.test(l.trim()));
      caNeedle = body ? body.trim().slice(0, 64) : null;
    }
    const scanOptions = { seedHashes, caSha256, caNeedle };

    // 1) Build CANONICO: el Dockerfile EXACTO del repo, target runtime.
    say('canonical Dockerfile build START');
    const buildArgs = ['build', '-f', 'Dockerfile', '--target', 'runtime', '-t', tag];
    if (network) buildArgs.push('--network', network);
    if (caFile) buildArgs.push('--secret', `id=fluvia_build_ca,src=${caFile}`);
    buildArgs.push('.');
    say(`tag: ${tag}`);
    await run('docker', buildArgs, { timeoutMs: 900_000 });

    // 2) Config de la imagen: USER/CMD/ENV + ID/digest.
    const inspect = JSON.parse(
      await run('docker', ['image', 'inspect', tag], { timeoutMs: 60_000 })
    );
    const image = inspect[0];
    say(`image ID: ${image.Id}`);
    if (image.RepoDigests?.length) say(`image digest: ${image.RepoDigests[0]}`);
    if (image.Config.User !== 'node') {
      violations.push(`USER is "${image.Config.User}", expected "node"`);
    }
    const cmdJson = JSON.stringify(image.Config.Cmd);
    if (cmdJson !== JSON.stringify(['pnpm', '--filter', '@fluvia/api', 'start'])) {
      violations.push(`CMD is ${cmdJson}`);
    }
    for (const e of image.Config.Env ?? []) {
      if (e.startsWith('NODE_EXTRA_CA_CERTS=')) {
        violations.push('image ENV leaks NODE_EXTRA_CA_CERTS');
      }
    }
    if (caNeedle !== null && JSON.stringify(image.Config).includes(caNeedle)) {
      violations.push('image config embeds build CA material');
    }

    // 2b) docker history --no-trunc: sin material CA persistido.
    const history = await run('docker', ['history', '--no-trunc', tag], { timeoutMs: 60_000 });
    if (history.trim() === '') violations.push('docker history is empty (fail-closed)');
    if (caNeedle !== null && history.includes(caNeedle)) {
      violations.push('docker history embeds build CA material');
    }
    if (/NODE_EXTRA_CA_CERTS=\/(?!run\/secrets)/.test(history)) {
      violations.push('docker history persists NODE_EXTRA_CA_CERTS outside the secret mount');
    }

    // 3) Filesystem MERGED (docker export, parser propio fail-closed).
    const merged = await scanMergedFilesystem(tag, work, 'positive', scanOptions);
    say(`merged filesystem entries: ${merged.count}`);
    violations.push(...merged.scanner.violations);
    for (const required of [
      'app/apps/api/package.json',
      'app/apps/worker/package.json',
      'app/package.json',
    ]) {
      if (!merged.scanner.paths.has(required)) violations.push(`merged: missing ${required}`);
    }
    if (merged.scanner.paths.has('app/scripts/verify-runtime-image.mjs')) {
      violations.push('merged: the verifier itself shipped inside the runtime image');
    }

    // 4) TODAS las capas del manifiesto de la imagen final.
    const layerScan = await scanImageLayers(tag, work, 'positive', scanOptions);
    violations.push(...layerScan.violations);

    const hashClean = !violations.some((v) => v.includes('content-hash matches'));
    say(`content-hash scan ${hashClean ? 'PASS' : 'FAIL'}`);
    const semanticClean = !violations.some((v) => v.includes('semantic signature'));
    say(`semantic-signature scan ${semanticClean ? 'PASS' : 'FAIL'}`);
    if (caFile) {
      const caClean = !violations.some((v) => v.includes('CA'));
      say(`CA persistence scan ${caClean ? 'PASS' : 'FAIL'}`);
    } else {
      say('CA persistence scan N-A (no build CA provided; residue checks still enforced)');
    }

    // 5) CONTROL NEGATIVO real: COPY fixture destructivo + rm posterior. El
    //    contexto temporal es EXCLUSIVO de la imagen negativa (la positiva
    //    usa SIEMPRE el Dockerfile canonico del checkout). FROM = el MISMO
    //    digest base pineado del Dockerfile del repo (ya presente local).
    const dockerfileText = readFileSync(join(REPO_ROOT, 'Dockerfile'), 'utf8');
    const baseFrom = /FROM\s+(node:22-slim@sha256:[0-9a-f]{64})\s+AS\s+base/.exec(dockerfileText);
    if (!baseFrom) throw new Error('cannot locate pinned base FROM in Dockerfile (fail-closed)');
    const negDir = join(work, 'negative-context');
    mkdirSync(negDir, { recursive: true });
    writeFileSync(
      join(negDir, 'fixture.dat'),
      readFileSync(join(REPO_ROOT, 'packages/seeds/src/reset.ts'))
    );
    writeFileSync(
      join(negDir, 'Dockerfile'),
      `FROM ${baseFrom[1]}\nWORKDIR /app\nCOPY fixture.dat /app/tools/reset-showroom.js\nRUN rm /app/tools/reset-showroom.js\n`
    );
    const negBuildArgs = ['build', '-f', join(negDir, 'Dockerfile'), '-t', negTag];
    if (network) negBuildArgs.push('--network', network);
    negBuildArgs.push(negDir);
    await run('docker', negBuildArgs, { timeoutMs: 300_000 });

    const negMerged = await scanMergedFilesystem(negTag, work, 'negative', scanOptions);
    const negMergedHits = negMerged.scanner.violations.filter((v) =>
      v.includes('content-hash matches')
    );
    const negLayers = await scanImageLayers(negTag, work, 'negative', scanOptions);
    const negDetected = negLayers.violations.some((v) => v.includes('content-hash matches'));
    if (negMergedHits.length !== 0) {
      violations.push('negative control: fixture visible in MERGED fs (rm did not apply?)');
    }
    if (!negDetected) {
      violations.push(
        'negative control NOT detected: layer scan missed a COPY+rm destructive fixture (fail-closed)'
      );
    } else {
      say('negative image detected PASS');
    }

    // 6) Smokes REALES dentro de la imagen final (PG/Redis de test via host).
    await runSmoke(tag, 'API', apiContainer, ['-e', 'PORT=3105'], 'http://127.0.0.1:3105/ready', [
      'pnpm',
      '--filter',
      '@fluvia/api',
      'start',
    ]);
    say('API smoke PASS');
    await runSmoke(
      tag,
      'worker',
      workerContainer,
      ['-e', 'WORKER_METRICS_PORT=9465'],
      'http://127.0.0.1:9465/metrics',
      ['pnpm', '--filter', '@fluvia/worker', 'start']
    );
    say('worker smoke PASS');

    // 7) El package.json del CHECKOUT conserva los tres scripts locales.
    const repoPkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    for (const s of FORBIDDEN_SCRIPTS) {
      if (!Object.prototype.hasOwnProperty.call(repoPkg.scripts ?? {}, s)) {
        violations.push(`checkout package.json lost local script "${s}"`);
      }
    }

    if (violations.length > 0) {
      for (const v of violations) {
        console.error(`[runtime:image:verify] VIOLATION: ${redactForLog(v)}`);
      }
      process.exitCode = 1;
      say(`FAIL (${violations.length} violations, ${Date.now() - startedAt}ms)`);
    } else {
      say(`elapsed: ${Date.now() - startedAt}ms`);
      say('PASS');
    }
  } finally {
    // 8) Cleanup SIEMPRE, cada recurso con su intento individual.
    for (const step of [
      () => run('docker', ['rm', '-f', apiContainer], { timeoutMs: 30_000 }),
      () => run('docker', ['rm', '-f', workerContainer], { timeoutMs: 30_000 }),
      () => run('docker', ['rmi', '-f', tag], { timeoutMs: 60_000 }),
      () => run('docker', ['rmi', '-f', negTag], { timeoutMs: 60_000 }),
    ]) {
      try {
        await step();
      } catch {
        // recursos inexistentes tras un fallo temprano: no es fallo de cleanup
      }
    }
    try {
      rmSync(work, { recursive: true, force: true });
      say('cleanup PASS');
    } catch {
      cleanupFailed = true;
      console.error('[runtime:image:verify] cleanup FAILED (workdir)');
    }
    clearTimeout(globalTimer);
    if (cleanupFailed && process.exitCode === undefined) process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(
      `[runtime:image:verify] ERROR: ${redactForLog(err instanceof Error ? err.message : String(err))}`
    );
    process.exitCode = 1;
  });
}
