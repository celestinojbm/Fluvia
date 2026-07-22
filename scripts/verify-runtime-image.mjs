#!/usr/bin/env node
/* global process, console, Buffer, setTimeout, clearTimeout */
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
function scanTarCore(reader, capture, onEntry, options = {}) {
  const needle = options.needle ?? null;
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
      // TERMINACION ESTRICTA (delta 3): un tar valido termina con AL MENOS
      // DOS bloques de 512 bytes completamente cero CONSECUTIVOS. Un unico
      // bloque cero, o EOF entre los dos bloques, es un formato invalido.
      if (reader.remaining() < 512) {
        throw new TarFormatError('EOF between tar terminator blocks (single zero block)');
      }
      if (!isZeroBlock(reader.read(512))) {
        throw new TarFormatError('single zero block is not a valid tar terminator');
      }
      if (
        pendingLongName !== undefined ||
        pendingLongLink !== undefined ||
        pendingPax !== undefined
      ) {
        throw new TarFormatError('pending PAX/GNU extension without a consuming entry');
      }
      sawTerminator = true;
      // Tras el terminador SOLO se admite padding adicional completamente cero.
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
        if (needle !== null && data.includes(needle)) entry.needleHit = true;
        entry.content = Buffer.from(data);
      } else {
        // hash en chunks sin retener el contenido; la aguja (material CA) se
        // busca en STREAMING sobre TODO archivo regular de CUALQUIER path,
        // con solapamiento entre chunks para no partir la coincidencia.
        let left = size;
        let tail = null;
        while (left > 0) {
          const take = Math.min(left, CHUNK);
          const chunk = reader.read(take);
          hash.update(chunk);
          if (needle !== null) {
            const window = tail === null ? chunk : Buffer.concat([tail, chunk]);
            if (window.includes(needle)) entry.needleHit = true;
            tail = chunk.subarray(Math.max(0, chunk.length - (needle.length - 1)));
          }
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

  // FAIL-CLOSED: cero terminadores (EOF tras la ultima entrada, header
  // parcial o archivo vacio) invalida el tar COMPLETO.
  if (!sawTerminator) {
    throw new TarFormatError(
      'missing tar terminator (two consecutive zero blocks required) or truncated archive'
    );
  }
  return count;
}

/**
 * Version PURA sobre Buffer (para tests): devuelve el array completo de
 * entradas (con content en las capturadas). Fail-closed via TarFormatError.
 */
export function parseTarEntries(buf, capture = () => false, options = {}) {
  const entries = [];
  scanTarCore(bufferReader(buf), capture, (e) => entries.push(e), options);
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

// ---------------------------------------------------------------------------
// Delta 3 — deteccion de copias TRANSFORMADAS (fingerprint lexico canonico).
// Contrato honesto (residual DOCUMENTADO): NO pretende detectar ofuscacion
// deliberada/criptografica ni codigo malicioso arbitrario; SI detecta el
// packaging ACCIDENTAL y las transformaciones normales del tooling —
// minificacion de whitespace, comentarios eliminados, comillas cambiadas,
// transpilacion TS->JS razonable, cambio de path/nombre y source maps con
// sourcesContent — de los archivos de packages/seeds/src.
// ---------------------------------------------------------------------------

/**
 * Tokeniza JS/TS/JSON a un stream CANONICO: sin whitespace, sin comentarios
 * (linea y bloque), strings con comillas NORMALIZADAS (token `S:<valor>`
 * independiente del tipo de comilla), identificadores/numeros enteros como
 * tokens y cada signo de puntuacion como token propio.
 */
export function canonicalTokens(source) {
  const s = String(source);
  const n = s.length;
  const tokens = [];
  const isIdent = (c) => /[A-Za-z0-9_$]/.test(c);
  let i = 0;
  while (i < n) {
    const c = s[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '/' && s[i + 1] === '/') {
      while (i < n && s[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      i += 2;
      while (i < n && !(s[i] === '*' && s[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      let out = '';
      while (j < n && s[j] !== c) {
        if (s[j] === '\\') {
          out += s[j] + (s[j + 1] ?? '');
          j += 2;
          continue;
        }
        out += s[j];
        j++;
      }
      tokens.push(`S:${out}`);
      i = j + 1;
      continue;
    }
    if (isIdent(c)) {
      let j = i;
      while (j < n && isIdent(s[j])) j++;
      tokens.push(s.slice(i, j));
      i = j;
      continue;
    }
    tokens.push(c);
    i++;
  }
  return tokens;
}

// Separador de tokens del fingerprint canonico: NUL (expresado como escape
// textual, jamas como byte literal en este source). NUL no puede aparecer
// dentro de un token canonico, asi que fronteras de tokens DISTINTAS jamas
// colisionan (['ab','c'] vs ['a','bc']); un separador imprimible como el
// espacio o la coma seria ambiguo frente a literales normalizados.
const TOKEN_SEPARATOR = '\u0000';

/** Hash del token stream canonico (identico ante whitespace/comentarios/comillas). */
export function lexicalFingerprint(source) {
  return createHash('sha256').update(canonicalTokens(source).join(TOKEN_SEPARATOR)).digest('hex');
}

const SHINGLE_K = 16;

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Ventanas (shingles) de K tokens para similitud estructural. */
export function tokenShingles(tokens, k = SHINGLE_K) {
  const set = new Set();
  for (let i = 0; i + k <= tokens.length; i++) {
    set.add(fnv1a(tokens.slice(i, i + k).join(TOKEN_SEPARATOR)));
  }
  return set;
}

/** Literales string SIGNIFICATIVAS de un fuente (8..200 chars). */
export function extractStringLiterals(source) {
  const out = new Set();
  for (const token of canonicalTokens(source)) {
    if (token.startsWith('S:')) {
      const value = token.slice(2);
      if (value.length >= 8 && value.length <= 200) out.add(value);
    }
  }
  return out;
}

/** Umbrales del veredicto de copia transformada (calibrados por tests). */
const LEXICAL_MIN_SHARED_LITERALS = 8;
const LEXICAL_LITERAL_OVERLAP_RATIO = 0.5;
const LEXICAL_SHINGLE_CONTAINMENT = 0.25;

/**
 * Construye el inventario LEXICO de los sources del checkout: por archivo,
 * fingerprint canonico, literales y shingles; mas las agujas de PRE-SCREEN
 * (las literales mas largas de cada archivo) para no tokenizar todo el
 * universo de node_modules.
 */
export function buildLexicalInventory(files) {
  const entries = [];
  const screenNeedles = new Set();
  for (const { path, text } of files) {
    const tokens = canonicalTokens(text);
    const literals = new Set();
    for (const token of tokens) {
      if (token.startsWith('S:')) {
        const value = token.slice(2);
        if (value.length >= 8 && value.length <= 200) literals.add(value);
      }
    }
    entries.push({
      path,
      fingerprint: createHash('sha256').update(tokens.join(TOKEN_SEPARATOR)).digest('hex'),
      literals,
      shingles: tokenShingles(tokens),
    });
    const longest = [...literals].filter((l) => l.length >= 12).sort((a, b) => b.length - a.length);
    for (const needle of longest.slice(0, 3)) screenNeedles.add(needle);
  }
  return { entries, screenNeedles: [...screenNeedles] };
}

/**
 * Veredicto de copia TRANSFORMADA: fingerprint canonico identico (copia
 * whitespace-minified / sin comentarios / comillas cambiadas / renombrada), o
 * solape masivo de literales + contencion estructural de shingles
 * (transpilacion TS->JS razonable, edicion superficial). Jamas dispara por
 * una unica palabra generica. Devuelve una descripcion o null.
 */
export function transformedCopyViolation(candidateText, lexicalInventory) {
  const candTokens = canonicalTokens(candidateText);
  const candFingerprint = createHash('sha256').update(candTokens.join(TOKEN_SEPARATOR)).digest('hex');
  const candLiterals = new Set();
  for (const token of candTokens) {
    if (token.startsWith('S:')) {
      const value = token.slice(2);
      if (value.length >= 8 && value.length <= 200) candLiterals.add(value);
    }
  }
  let candShingles = null;
  for (const entry of lexicalInventory.entries) {
    if (entry.fingerprint === candFingerprint) {
      return `${entry.path} (canonical token stream identical)`;
    }
    if (entry.literals.size < LEXICAL_MIN_SHARED_LITERALS) continue;
    let shared = 0;
    for (const literal of entry.literals) {
      if (candLiterals.has(literal)) shared++;
    }
    if (
      shared < LEXICAL_MIN_SHARED_LITERALS ||
      shared < Math.ceil(entry.literals.size * LEXICAL_LITERAL_OVERLAP_RATIO)
    ) {
      continue;
    }
    if (candShingles === null) candShingles = tokenShingles(candTokens);
    let hit = 0;
    for (const shingle of entry.shingles) {
      if (candShingles.has(shingle)) hit++;
    }
    const containment = entry.shingles.size === 0 ? 0 : hit / entry.shingles.size;
    if (containment >= LEXICAL_SHINGLE_CONTAINMENT) {
      return `${entry.path} (literal overlap ${shared}/${entry.literals.size}, shingle containment ${containment.toFixed(2)})`;
    }
  }
  return null;
}

/** Pre-screen barato: ¿el contenido contiene alguna aguja del inventario? */
export function matchesLexicalScreen(text, lexicalInventory) {
  for (const needle of lexicalInventory.screenNeedles) {
    if (text.includes(needle)) return true;
  }
  return false;
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
 * ¿Una entrada de dependencia (CLAVE y VALOR) resuelve @fluvia/seeds?
 * Cubre (delta 3): clave directa `@fluvia/seeds`; aliases `npm:@fluvia/seeds`
 * y `workspace:@fluvia/seeds` (con o sin version/range); y enlaces
 * `file:`/`link:`/`portal:` dirigidos EXACTAMENTE a `packages/seeds`. Jamas
 * un substring generico: `packages/oilseeds` o `@example/seeds` NO resuelven.
 */
export function dependencySpecResolvesFluviaSeeds(name, spec) {
  if (String(name) === '@fluvia/seeds') return true;
  const s = String(spec).trim();
  if (/^npm:@fluvia\/seeds(@.*)?$/.test(s)) return true;
  if (/^workspace:@fluvia\/seeds(@.*)?$/.test(s)) return true;
  const linkMatch = /^(file|link|portal):(.*)$/.exec(s);
  if (linkMatch) {
    const target = linkMatch[2].replace(/\\/g, '/').replace(/\/+$/, '');
    const segments = target.split('/').filter((seg) => seg !== '' && seg !== '.');
    for (let i = 0; i + 1 < segments.length; i++) {
      if (segments[i] === 'packages' && segments[i + 1] === 'seeds' && i + 2 === segments.length) {
        return true;
      }
    }
  }
  return false;
}

/**
 * ¿Un patron de `workspaces` puede resolver el path LOGICO exacto
 * `packages/seeds`? Match por SEGMENTOS: `*` = un segmento, `**` = cero o
 * mas, literal = exacto. `packages/oilseeds` y `some-seeds-helper` jamas
 * matchean; `packages/*` y `packages/seeds` si.
 */
export function workspacePatternCanResolveFluviaSeeds(pattern) {
  const raw = String(pattern).replace(/\/+$/, '');
  const target = ['packages', 'seeds'];
  const segs = raw.split('/').filter((seg) => seg !== '' && seg !== '.');
  const match = (si, ti) => {
    if (si === segs.length) return ti === target.length;
    const seg = segs[si];
    if (seg === '**') {
      for (let skip = ti; skip <= target.length; skip++) {
        if (match(si + 1, skip)) return true;
      }
      return false;
    }
    if (ti === target.length) return false;
    const re = new RegExp(
      `^${seg
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '.')}$`
    );
    return re.test(target[ti]) && match(si + 1, ti + 1);
  };
  return match(0, 0);
}

const DEPENDENCY_MAP_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];

function scanDependencyMap(violations, path, label, map) {
  if (map === undefined) return;
  if (map === null || typeof map !== 'object' || Array.isArray(map)) {
    violations.push(`${path}: ${label} is not an object (fail-closed)`);
    return;
  }
  for (const [name, spec] of Object.entries(map)) {
    if (dependencySpecResolvesFluviaSeeds(name, spec)) {
      violations.push(`${path}: ${label} resolves @fluvia/seeds (${name})`);
    }
  }
}

/**
 * Violaciones de UN package.json (fail-closed, jamas "lista vacia" por error
 * de parseo — delta 3): JSON invalido en CUALQUIER package.json inspeccionado
 * = violacion; package.json no-objeto = violacion; scripts no-objeto =
 * violacion; scripts prohibidos (solo manifiestos workspace: un script `seed`
 * PROPIO de una dependencia ajena no es nuestro tooling) = violacion;
 * metadata que RESUELVA @fluvia/seeds — clave O VALOR (aliases npm:/
 * workspace:/file:/link:), en dependencies/devDependencies/
 * optionalDependencies/peerDependencies/overrides/resolutions/pnpm.overrides/
 * pnpm.packageExtensions — = violacion; `workspaces` que PUEDA resolver el
 * path exacto `packages/seeds` = violacion; metadata inesperada = violacion.
 */
export function packageJsonViolations(rawText, path) {
  const kind = manifestKindForPath(path);
  if (kind === null) return [];
  const text = String(rawText);
  const violations = [];
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
  for (const field of DEPENDENCY_MAP_FIELDS) {
    scanDependencyMap(violations, path, field, pkg[field]);
  }
  scanDependencyMap(violations, path, 'overrides', pkg.overrides);
  scanDependencyMap(violations, path, 'resolutions', pkg.resolutions);
  if (pkg.pnpm !== undefined) {
    if (pkg.pnpm === null || typeof pkg.pnpm !== 'object' || Array.isArray(pkg.pnpm)) {
      violations.push(`${path}: pnpm metadata is not an object (fail-closed)`);
    } else {
      scanDependencyMap(violations, path, 'pnpm.overrides', pkg.pnpm.overrides);
      const ext = pkg.pnpm.packageExtensions;
      if (ext !== undefined) {
        if (ext === null || typeof ext !== 'object' || Array.isArray(ext)) {
          violations.push(`${path}: pnpm.packageExtensions is not an object (fail-closed)`);
        } else {
          for (const [extName, extBody] of Object.entries(ext)) {
            if (dependencySpecResolvesFluviaSeeds(extName, '')) {
              violations.push(`${path}: pnpm.packageExtensions resolves @fluvia/seeds`);
            }
            if (extBody !== null && typeof extBody === 'object' && !Array.isArray(extBody)) {
              for (const field of DEPENDENCY_MAP_FIELDS) {
                scanDependencyMap(
                  violations,
                  path,
                  `pnpm.packageExtensions.${field}`,
                  extBody[field]
                );
              }
            }
          }
        }
      }
    }
  }
  if (pkg.workspaces !== undefined) {
    const patterns = Array.isArray(pkg.workspaces)
      ? pkg.workspaces
      : pkg.workspaces !== null &&
          typeof pkg.workspaces === 'object' &&
          Array.isArray(pkg.workspaces.packages)
        ? pkg.workspaces.packages
        : null;
    if (patterns === null) {
      violations.push(`${path}: workspaces has an unexpected shape (fail-closed)`);
    } else {
      for (const pattern of patterns) {
        if (workspacePatternCanResolveFluviaSeeds(pattern)) {
          violations.push(`${path}: workspaces pattern can resolve packages/seeds ("${pattern}")`);
        }
      }
    }
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
  const { seedHashes = new Map(), caSha256 = null, lexicalInventory = null } = options;
  const violations = [];
  const hashByPath = new Map();
  const paths = new Set();
  let entryCount = 0;

  const scanSourceMap = (path, text) => {
    let map;
    try {
      map = JSON.parse(text);
    } catch {
      violations.push(`${label}: ${path} invalid JSON in source map (fail-closed)`);
      return;
    }
    if (map === null || typeof map !== 'object' || Array.isArray(map)) {
      violations.push(`${label}: ${path} source map is not an object (fail-closed)`);
      return;
    }
    if (map.sourcesContent === undefined || map.sourcesContent === null) return;
    if (!Array.isArray(map.sourcesContent)) {
      violations.push(`${label}: ${path} sourcesContent is not an array (fail-closed)`);
      return;
    }
    for (const [i, content] of map.sourcesContent.entries()) {
      if (content === null) continue;
      if (typeof content !== 'string') {
        violations.push(`${label}: ${path} sourcesContent[${i}] is not a string (fail-closed)`);
        continue;
      }
      const hash = createHash('sha256').update(content).digest('hex');
      const exact = seedHashes.get(hash);
      if (exact !== undefined) {
        violations.push(
          `${label}: ${path} sourcesContent[${i}] content-hash matches checkout ${exact}`
        );
      }
      const semantic = semanticSignatureViolation(content);
      if (semantic.length > 0) {
        violations.push(
          `${label}: ${path} sourcesContent[${i}] semantic signature [${semantic.join(', ')}]`
        );
      }
      if (lexicalInventory !== null && matchesLexicalScreen(content, lexicalInventory)) {
        const copy = transformedCopyViolation(content, lexicalInventory);
        if (copy !== null) {
          violations.push(
            `${label}: ${path} sourcesContent[${i}] transformed copy of checkout ${copy}`
          );
        }
      }
    }
  };

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
    if (e.type === 'symlink' && /(^|\/)run\/secrets(\/|$)/.test(String(e.linkTarget ?? ''))) {
      // No se sigue el symlink; su TARGET sospechoso se reporta.
      violations.push(`${label}: symlink ${e.path} -> suspicious target (run/secrets)`);
    }
    let contentHash = null;
    if (e.type === 'file') {
      contentHash = e.sha256;
      hashByPath.set(e.path, e.sha256);
      if (e.needleHit === true) {
        // Aguja del material CA hallada en STREAMING — en CUALQUIER path del
        // filesystem, no solo /app (delta 3).
        violations.push(`${label}: ${e.path} embeds build CA material`);
      }
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
    // Comparacion por hash contra el inventario del tooling y contra la CA en
    // TODO el filesystem (delta 3: /app, /usr, /etc, /root, /home, cualquier
    // path; hardlinks resueltos). El inventario y la CA excluyen archivos
    // vacios: el hash del archivo vacio jamas esta en los mapas.
    if (contentHash !== null) {
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
        if (e.path.endsWith('.map')) {
          scanSourceMap(e.path, text);
        } else {
          const hit = semanticSignatureViolation(text);
          if (hit.length > 0) {
            violations.push(`${label}: ${e.path} semantic signature [${hit.join(', ')}]`);
          }
          if (lexicalInventory !== null && matchesLexicalScreen(text, lexicalInventory)) {
            const copy = transformedCopyViolation(text, lexicalInventory);
            if (copy !== null) {
              violations.push(`${label}: ${e.path} transformed copy of checkout ${copy}`);
            }
          }
        }
      }
      for (const v of packageJsonViolations(text, e.path)) {
        violations.push(`${label}: ${v}`);
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
 * process group entero (SIGKILL: un proceso que ignore SIGTERM y sus nietos
 * mueren igual). Exit != 0 => Error con stderr acotado y REDACTADO.
 *
 * Limites de output FAIL-CLOSED (delta 3), medidos en BYTES (no longitud
 * UTF-16): si stdout O stderr exceden el limite, el process group se mata y
 * la llamada FALLA con un error FIJO y sanitizado — aunque el proceso
 * terminara con exit 0; ningun output parcial/truncado se analiza jamas.
 * Exportada como `runBoundedProcess` para tests con procesos reales.
 */
export function runBoundedProcess(cmd, args, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const limitBytes = opts.outputLimitBytes ?? OUTPUT_LIMIT;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd ?? REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DOCKER_BUILDKIT: '1' },
      detached: true,
    });
    const outChunks = [];
    const errChunks = [];
    let outBytes = 0;
    let errBytes = 0;
    let overflow = false;
    let timedOut = false;
    let settled = false;
    const killGroup = () => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      const chunk = Buffer.isBuffer(d) ? d : Buffer.from(d);
      outBytes += chunk.length;
      if (outBytes > limitBytes) {
        overflow = true;
        killGroup();
        return;
      }
      outChunks.push(chunk);
    });
    child.stderr.on('data', (d) => {
      const chunk = Buffer.isBuffer(d) ? d : Buffer.from(d);
      errBytes += chunk.length;
      if (errBytes > limitBytes) {
        overflow = true;
        killGroup();
        return;
      }
      errChunks.push(chunk);
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
        // Error FIJO y sanitizado: jamas incluye el output desbordado.
        reject(new Error(`${cmd} ${args[0] ?? ''} exceeded the output byte limit (fail-closed)`));
      } else if (timedOut) {
        reject(new Error(`${cmd} ${args[0] ?? ''} timed out after ${timeoutMs}ms (group killed)`));
      } else if (code === 0) {
        resolve({
          stdout: Buffer.concat(outChunks).toString('utf8'),
          stderr: Buffer.concat(errChunks).toString('utf8'),
        });
      } else {
        const tail = redactForLog(
          Buffer.concat(errChunks).toString('utf8').split('\n').slice(-15).join('\n')
        );
        reject(
          new Error(
            `${cmd} ${args.slice(0, 3).join(' ')} exited ${code ?? `signal ${signal}`}\n${tail}`
          )
        );
      }
    });
  });
}

const runFull = runBoundedProcess;

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
function scanTarFileStreaming(tarPath, label, scanner, coreOptions = {}) {
  const size = statSync(tarPath).size;
  if (size === 0) throw new Error(`${label}: empty tar (fail-closed)`);
  const fd = openSync(tarPath, 'r');
  try {
    return scanTarCore(fdReader(fd, size), shouldCaptureContent, scanner.onEntry, coreOptions);
  } catch (err) {
    throw err instanceof TarFormatError ? new Error(`${label}: ${err.message} (fail-closed)`) : err;
  } finally {
    closeSync(fd);
  }
}

/** Inventario del tooling del showroom en el CHECKOUT: hashes exactos +
 * inventario LEXICO (fingerprints/literales/shingles + agujas de screen). */
function buildSeedInventories() {
  const hashInventory = new Map();
  const lexicalFiles = [];
  const addFile = (abs, repoRel) => {
    const data = readFileSync(abs);
    if (data.length === 0) return; // el hash del archivo vacio colisiona con todo
    hashInventory.set(createHash('sha256').update(data).digest('hex'), repoRel);
    if (/\.(ts|mts|cts|js|mjs|cjs|json)$/.test(repoRel)) {
      lexicalFiles.push({ path: repoRel, text: data.toString('utf8') });
    }
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
  if (hashInventory.size === 0) throw new Error('seed content inventory is empty (fail-closed)');
  const lexicalInventory = buildLexicalInventory(lexicalFiles);
  if (lexicalInventory.entries.length === 0 || lexicalInventory.screenNeedles.length === 0) {
    throw new Error('seed lexical inventory is empty (fail-closed)');
  }
  return { hashInventory, lexicalInventory };
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
    const count = scanTarFileStreaming(plainTar, `${label} layer ${layer}`, scanner, {
      needle: scanOptions.caNeedleBuffer ?? null,
    });
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

/** docker export del contenedor (sin iniciar) -> scan streaming del merged.
 * El contenedor temporal se registra en el TRACKER: su borrado se verifica. */
async function scanMergedFilesystem(tag, work, label, scanOptions, tracker) {
  const containerId = (await run('docker', ['create', tag], { timeoutMs: 60_000 })).trim();
  if (containerId === '') throw new Error('docker create returned empty id (fail-closed)');
  tracker.register('container', containerId, `${label}-merged-container`);
  try {
    const mergedTar = join(work, `${label}-merged.tar`);
    await run('docker', ['export', '-o', mergedTar, containerId], { timeoutMs: 600_000 });
    const scanner = createTarScanner(`${label} merged`, scanOptions);
    const count = scanTarFileStreaming(mergedTar, `${label} merged`, scanner, {
      needle: scanOptions.caNeedleBuffer ?? null,
    });
    if (count === 0) throw new Error(`${label}: merged export is empty (fail-closed)`);
    rmSync(mergedTar, { force: true });
    return { scanner, count };
  } finally {
    // El intento inmediato es solo higiene: el resultado VERIFICADO lo decide
    // el tracker en el cleanup final (un rm fallido con el recurso vivo =
    // cleanup FAILED, jamas silencioso).
    await tracker.removeNow('container', containerId);
  }
}

// ---------------------------------------------------------------------------
// Delta 3 — cleanup Docker VERIFICABLE: cada recurso creado se registra; su
// borrado se INTENTA (con timeout por recurso) y se VERIFICA via inspect; un
// recurso que sigue existiendo tras el intento = cleanup FAILED y exit != 0.
// `cleanup PASS` SOLO cuando todos los recursos creados fueron confirmados
// ausentes. Un fallo del cleanup jamas oculta el error primario del verifier.
// ---------------------------------------------------------------------------

const CLEANUP_RESOURCE_TIMEOUT_MS = 45_000;

const REMOVE_ARGS = {
  container: (id) => ['rm', '-f', id],
  image: (id) => ['rmi', '-f', id],
  network: (id) => ['network', 'rm', id],
  volume: (id) => ['volume', 'rm', '-f', id],
};
const VERIFY_ARGS = {
  container: (id) => ['inspect', '--type', 'container', id],
  image: (id) => ['inspect', '--type', 'image', id],
  network: (id) => ['network', 'inspect', id],
  volume: (id) => ['volume', 'inspect', id],
};

/**
 * Tracker tipado de recursos Docker. `exec(args, timeoutMs)` es inyectable
 * para tests puros: debe resolver en exito y rechazar en fallo (como
 * `run('docker', args)`).
 */
export function createDockerCleanupTracker(exec) {
  const resources = [];
  const findLive = (kind, id) =>
    resources.find((r) => r.kind === kind && r.id === id && r.state === 'created');

  const removeOne = async (resource) => {
    let removeFailed = false;
    try {
      await exec(REMOVE_ARGS[resource.kind](resource.id), CLEANUP_RESOURCE_TIMEOUT_MS);
    } catch {
      removeFailed = true;
    }
    // VERIFICACION: inspect con exito => el recurso SIGUE existiendo.
    let stillExists;
    try {
      await exec(VERIFY_ARGS[resource.kind](resource.id), CLEANUP_RESOURCE_TIMEOUT_MS);
      stillExists = true;
    } catch {
      stillExists = false;
    }
    resource.state = stillExists ? 'cleanup_failed' : 'verified_absent';
    resource.removeFailed = removeFailed;
    return !stillExists;
  };

  return {
    register(kind, id, label) {
      if (!(kind in REMOVE_ARGS)) throw new Error(`unknown docker resource kind: ${kind}`);
      resources.push({ kind, id, label: label ?? id, state: 'created', removeFailed: false });
    },
    /** Borrado inmediato + verificacion de UN recurso ya registrado. */
    async removeNow(kind, id) {
      const resource = findLive(kind, id);
      if (resource === undefined) return true;
      return removeOne(resource);
    },
    /** Borra y VERIFICA todo lo aun vivo. Devuelve el resumen tipado.
     * Orden por DEPENDENCIA: contenedores -> redes -> volumenes -> imagenes
     * (una red no puede borrarse con contenedores conectados, ni una imagen
     * con contenedores vivos). */
    async cleanupAll() {
      const KIND_ORDER = { container: 0, network: 1, volume: 2, image: 3 };
      const ordered = [...resources].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
      for (const resource of ordered) {
        if (resource.state !== 'created') continue;
        await removeOne(resource);
      }
      const failures = resources
        .filter((r) => r.state === 'cleanup_failed')
        .map((r) => ({ kind: r.kind, label: r.label }));
      return {
        ok: failures.length === 0,
        failures,
        summary: resources.map((r) => `${r.kind}:${r.label}=${r.state}`),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Delta 3 — smokes REALMENTE OFFLINE: red Docker dedicada `--internal` (sin
// egress), PostgreSQL 16 + Redis 7 (las MISMAS referencias que ya usa el job
// de CI como services), migracion ejecutada por la PROPIA imagen runtime
// dentro de la red interna, probes via `docker exec` (sin puertos publicados,
// sin --network host, sin host.docker.internal, sin DNS publico).
// ---------------------------------------------------------------------------

async function execProbe(container, script, timeoutMs = 15_000) {
  await run('docker', ['exec', container, 'node', '-e', script], { timeoutMs });
}

async function pollExecProbe(container, script, attempts, delayMs) {
  for (let i = 0; i < attempts; i++) {
    try {
      await execProbe(container, script);
      return true;
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

const DOWNLOAD_LOG_RE =
  /MODULE_NOT_FOUND|Cannot find module|ERR_MODULE_NOT_FOUND|Corepack is about to download|corepack.*download|registry\.npmjs\.org|Downloading/i;

async function assertContainerHealthy(container, what, ready) {
  const running = (
    await run('docker', ['inspect', '-f', '{{.State.Running}}', container], {
      timeoutMs: 30_000,
    }).catch(() => 'false')
  ).trim();
  const logs = await containerLogsCombined(container);
  if (DOWNLOAD_LOG_RE.test(logs)) {
    throw new Error(
      `${what} smoke: runtime download attempt or missing module inside the image (fail-closed)`
    );
  }
  if (!ready || running !== 'true') {
    const tail = redactForLog(logs.split('\n').slice(-25).join('\n'));
    throw new Error(`${what} smoke FAILED (ready=${ready}, running=${running})\n${tail}`);
  }
}

/**
 * Levanta la red interna + PG16 + Redis7, prueba el AISLAMIENTO de egress,
 * pnpm offline, migra la base con la PROPIA imagen runtime y corre los smokes
 * de API y worker por `docker exec`. Todos los recursos van al tracker.
 */
async function runOfflineSmokes(tag, ids, tracker) {
  const { network, pg, redis, api, worker } = ids;

  await run('docker', ['network', 'create', '--internal', '--driver', 'bridge', network], {
    timeoutMs: 30_000,
  });
  tracker.register('network', network, 'internal-network');
  say('internal network created');

  await run(
    'docker',
    [
      'run',
      '-d',
      '--name',
      pg,
      '--network',
      network,
      '-e',
      'POSTGRES_USER=postgres',
      '-e',
      'POSTGRES_PASSWORD=postgres',
      '-e',
      'POSTGRES_DB=fluvia',
      'postgres:16',
    ],
    { timeoutMs: 120_000 }
  );
  tracker.register('container', pg, 'smoke-postgres');
  await run('docker', ['run', '-d', '--name', redis, '--network', network, 'redis:7'], {
    timeoutMs: 120_000,
  });
  tracker.register('container', redis, 'smoke-redis');

  // PG listo (probe DENTRO del contenedor; sin puertos publicados).
  let pgReady = false;
  for (let i = 0; i < 60 && !pgReady; i++) {
    try {
      await run('docker', ['exec', pg, 'pg_isready', '-U', 'postgres'], { timeoutMs: 10_000 });
      pgReady = true;
    } catch {
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
  if (!pgReady) throw new Error('smoke postgres did not become ready (fail-closed)');

  // AISLAMIENTO REAL: un intento de egress a Internet desde la red interna
  // DEBE fallar antes de dar por validos los smokes.
  let egressBlocked = false;
  try {
    await run(
      'docker',
      [
        'run',
        '--rm',
        '--network',
        network,
        tag,
        'node',
        '-e',
        `fetch('https://registry.npmjs.org', { signal: AbortSignal.timeout(5000) }).then(() => process.exit(0), () => process.exit(1))`,
      ],
      { timeoutMs: 30_000 }
    );
  } catch {
    egressBlocked = true;
  }
  if (!egressBlocked)
    throw new Error('offline egress probe FAILED: internet reachable (fail-closed)');
  say('offline egress probe PASS');

  // pnpm OFFLINE como USER node: la cache de corepack horneada basta; cero red.
  const pnpmVersion = (
    await run('docker', ['run', '--rm', '--network', network, tag, 'pnpm', '--version'], {
      timeoutMs: 60_000,
    })
  ).trim();
  if (!/^\d+\.\d+\.\d+$/.test(pnpmVersion)) {
    throw new Error('pnpm offline probe returned unexpected output (fail-closed)');
  }
  say('pnpm offline PASS');

  // Migracion con la PROPIA imagen runtime, dentro de la red interna.
  const dbEnv = [
    '-e',
    'NODE_ENV=test',
    '-e',
    `ADMIN_DATABASE_URL=postgres://postgres:postgres@${pg}:5432/fluvia`,
    '-e',
    `APP_DATABASE_URL=postgres://fluvia_app:fluvia_app_dev_password@${pg}:5432/fluvia`,
    '-e',
    `WORKER_DATABASE_URL=postgres://fluvia_worker:fluvia_worker_dev_password@${pg}:5432/fluvia`,
    '-e',
    `RELAY_DATABASE_URL=postgres://fluvia_relay:fluvia_relay_dev_password@${pg}:5432/fluvia`,
    '-e',
    `AUTH_DATABASE_URL=postgres://fluvia_auth:fluvia_auth_dev_password@${pg}:5432/fluvia`,
    '-e',
    `INBOX_DATABASE_URL=postgres://fluvia_inbox:fluvia_inbox_dev_password@${pg}:5432/fluvia`,
    '-e',
    `WEBHOOK_DATABASE_URL=postgres://fluvia_webhook:fluvia_webhook_dev_password@${pg}:5432/fluvia`,
    '-e',
    `REDIS_URL=redis://${redis}:6379`,
  ];
  await run('docker', ['run', '--rm', '--network', network, ...dbEnv, tag, 'pnpm', 'migrate'], {
    timeoutMs: 300_000,
  });
  say('database migration PASS');

  // API smoke OFFLINE: arranque real con el CMD real; readiness observable
  // via docker exec contra /ready (SELECT 1 real contra el PG interno).
  await run(
    'docker',
    [
      'run',
      '-d',
      '--name',
      api,
      '--network',
      network,
      ...dbEnv,
      '-e',
      'PORT=3000',
      tag,
      'pnpm',
      '--filter',
      '@fluvia/api',
      'start',
    ],
    { timeoutMs: 60_000 }
  );
  tracker.register('container', api, 'smoke-api');
  const apiReady = await pollExecProbe(
    api,
    `fetch('http://127.0.0.1:3000/ready').then((r) => process.exit(r.status === 200 ? 0 : 1), () => process.exit(1))`,
    60,
    1_500
  );
  await assertContainerHealthy(api, 'API', apiReady);
  say('API smoke offline PASS');

  // Worker smoke OFFLINE: metrics server como readiness observable.
  await run(
    'docker',
    [
      'run',
      '-d',
      '--name',
      worker,
      '--network',
      network,
      ...dbEnv,
      '-e',
      'WORKER_METRICS_PORT=9464',
      tag,
      'pnpm',
      '--filter',
      '@fluvia/worker',
      'start',
    ],
    { timeoutMs: 60_000 }
  );
  tracker.register('container', worker, 'smoke-worker');
  const workerReady = await pollExecProbe(
    worker,
    `fetch('http://127.0.0.1:9464/metrics').then((r) => process.exit(r.status === 200 ? 0 : 1), () => process.exit(1))`,
    60,
    1_500
  );
  await assertContainerHealthy(worker, 'worker', workerReady);
  say('worker smoke offline PASS');
}

async function main() {
  const startedAt = Date.now();
  const globalTimer = setTimeout(() => {
    console.error(`[runtime:image:verify] GLOBAL TIMEOUT after ${GLOBAL_TIMEOUT_MS}ms — FAIL`);
    process.exit(1);
  }, GLOBAL_TIMEOUT_MS);

  const caFile = process.env.FLUVIA_BUILD_CA_FILE;
  const network = process.env.FLUVIA_BUILD_NETWORK;
  const pid = process.pid;
  const tag = `fluvia-runtime-verify-${pid}`;
  const negTag = `fluvia-runtime-verify-neg-${pid}`;
  const smokeIds = {
    network: `fluvia-rtv-net-${pid}`,
    pg: `fluvia-rtv-pg-${pid}`,
    redis: `fluvia-rtv-redis-${pid}`,
    api: `fluvia-rtv-api-${pid}`,
    worker: `fluvia-rtv-worker-${pid}`,
  };
  const work = mkdtempSync(join(tmpdir(), 'fluvia-rtv-'));
  const violations = [];
  const tracker = createDockerCleanupTracker((args, timeoutMs) =>
    run('docker', args, { timeoutMs })
  );

  try {
    // 0) Docker OBLIGATORIO: su ausencia es un fallo del gate, jamas un skip.
    await run('docker', ['version', '--format', '{{.Server.Version}}'], { timeoutMs: 30_000 });
    say(`timeout configured: global=${GLOBAL_TIMEOUT_MS}ms`);

    // Inventarios del tooling (hash exacto + lexico) y material CA opcional.
    const { hashInventory: seedHashes, lexicalInventory } = buildSeedInventories();
    say(`seed content inventory: ${seedHashes.size} files hashed from the checkout`);
    say(
      `seed lexical inventory: ${lexicalInventory.entries.length} sources, ${lexicalInventory.screenNeedles.length} screen needles`
    );
    let caSha256 = null;
    let caNeedle = null;
    if (caFile) {
      const caBytes = readFileSync(caFile);
      if (caBytes.length === 0) throw new Error('FLUVIA_BUILD_CA_FILE is empty (fail-closed)');
      caSha256 = createHash('sha256').update(caBytes).digest('hex');
      // Aguja de 64 chars del cuerpo base64 del ULTIMO certificado del PEM
      // (linea CENTRAL): en un bundle, los primeros bloques suelen ser roots
      // PUBLICOS que binarios legitimos (p. ej. el node del runtime, que
      // embebe el root store de Mozilla) contienen — una aguja de un root
      // publico seria un falso positivo; el certificado PRIVADO del proxy va
      // al final y su material es el que JAMAS puede persistir en la imagen.
      // Nunca se vuelcan bytes/hash/cuerpo de la CA a los logs.
      const blocks = caBytes.toString('utf8').split('-----BEGIN CERTIFICATE-----');
      const lastBlock = blocks[blocks.length - 1] ?? '';
      const lines = lastBlock
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => /^[A-Za-z0-9+/=]{40,}$/.test(l));
      const mid = lines[Math.floor(lines.length / 2)];
      caNeedle = mid ? mid.slice(0, 64) : null;
    }
    const scanOptions = {
      seedHashes,
      caSha256,
      caNeedle,
      lexicalInventory,
      caNeedleBuffer: caNeedle === null ? null : Buffer.from(caNeedle, 'utf8'),
    };

    // 1) Build CANONICO: el Dockerfile EXACTO del repo, target runtime.
    say('canonical Dockerfile build START');
    const buildArgs = ['build', '-f', 'Dockerfile', '--target', 'runtime', '-t', tag];
    if (network) buildArgs.push('--network', network);
    if (caFile) buildArgs.push('--secret', `id=fluvia_build_ca,src=${caFile}`);
    buildArgs.push('.');
    say(`tag: ${tag}`);
    await run('docker', buildArgs, { timeoutMs: 900_000 });
    tracker.register('image', tag, 'positive-image');

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
    const merged = await scanMergedFilesystem(tag, work, 'positive', scanOptions, tracker);
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

    // Marcadores de scan (delta 3): el parser estricto ya corrio sobre TODOS
    // los tars (terminador doble obligatorio) y las nuevas familias de checks
    // reportan su estado calculado SOLO de las violaciones reales.
    say('tar strict terminator PASS');
    const hashClean = !violations.some((v) => v.includes('content-hash matches'));
    say(`content-hash scan ${hashClean ? 'PASS' : 'FAIL'}`);
    const semanticClean = !violations.some((v) => v.includes('semantic signature'));
    say(`semantic-signature scan ${semanticClean ? 'PASS' : 'FAIL'}`);
    const aliasClean = !violations.some(
      (v) =>
        v.includes('resolves @fluvia/seeds') ||
        v.includes('can resolve packages/seeds') ||
        v.includes('invalid JSON in package.json') ||
        v.includes('not an object (fail-closed)')
    );
    say(`package aliases ${aliasClean ? 'PASS' : 'FAIL'}`);
    const transformedClean = !violations.some((v) => v.includes('transformed copy'));
    say(`transformed-content scan ${transformedClean ? 'PASS' : 'FAIL'}`);
    if (caFile) {
      const caClean = !violations.some((v) => v.includes('CA'));
      say(`CA persistence scan ${caClean ? 'PASS' : 'FAIL'}`);
      say(`CA global scan ${caClean ? 'PASS' : 'FAIL'}`);
    } else {
      say('CA persistence scan N-A (no build CA provided; residue checks still enforced)');
      say('CA global scan N-A (no build CA provided; residue checks still enforced)');
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
    tracker.register('image', negTag, 'negative-image');

    const negMerged = await scanMergedFilesystem(negTag, work, 'negative', scanOptions, tracker);
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

    // 6) Smokes REALMENTE OFFLINE (delta 3): red interna sin egress; PG16 y
    //    Redis7 internos; migracion via la propia imagen; probes docker exec.
    await runOfflineSmokes(tag, smokeIds, tracker);

    // 7) El package.json del CHECKOUT conserva los tres scripts locales.
    const repoPkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    for (const s of FORBIDDEN_SCRIPTS) {
      if (!Object.prototype.hasOwnProperty.call(repoPkg.scripts ?? {}, s)) {
        violations.push(`checkout package.json lost local script "${s}"`);
      }
    }

    // Ningun proceso desbordo sus limites de bytes (un overflow habria
    // matado el process group y abortado el gate).
    say('stdout/stderr bounds PASS');

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
    // 8) Cleanup VERIFICABLE: cada recurso creado se borra y su AUSENCIA se
    //    confirma via inspect; un recurso vivo = cleanup FAILED + exit != 0.
    //    Jamas oculta el error primario del verifier.
    let cleanupOk = true;
    try {
      const result = await tracker.cleanupAll();
      cleanupOk = result.ok;
      if (!result.ok) {
        for (const failure of result.failures) {
          console.error(
            `[runtime:image:verify] cleanup FAILED: ${failure.kind} ${failure.label} still exists`
          );
        }
      } else {
        say('Docker cleanup verification PASS');
        if (smokeIds.network) say('internal network cleanup PASS');
      }
    } catch {
      cleanupOk = false;
      console.error('[runtime:image:verify] cleanup FAILED (tracker error)');
    }
    try {
      rmSync(work, { recursive: true, force: true });
    } catch {
      cleanupOk = false;
      console.error('[runtime:image:verify] cleanup FAILED (workdir)');
    }
    if (cleanupOk) {
      say('cleanup PASS');
    } else if (process.exitCode === undefined || process.exitCode === 0) {
      process.exitCode = 1;
    }
    clearTimeout(globalTimer);
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
