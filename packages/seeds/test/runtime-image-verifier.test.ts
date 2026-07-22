import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  FORBIDDEN_SCRIPTS,
  TarFormatError,
  isForbiddenImagePath,
  isForbiddenLinkTarget,
  isSemanticScanPath,
  manifestKindForPath,
  normalizeTarPath,
  packageJsonViolations,
  parseTarEntries,
  redactForLog,
  scanTarEntries,
  semanticSignatureViolation,
  shouldCaptureContent,
  dependencySpecResolvesFluviaSeeds,
  workspacePatternCanResolveFluviaSeeds,
  canonicalTokens,
  lexicalFingerprint,
  extractStringLiterals,
  buildLexicalInventory,
  transformedCopyViolation,
  matchesLexicalScreen,
  runBoundedProcess,
  createDockerCleanupTracker,
} from '../../../scripts/verify-runtime-image.mjs';

/**
 * RA-F65C3-EXT-002/EXT-007 (segunda delta) — helpers PUROS del verificador
 * fail-closed de la imagen runtime. Estos tests NO sustituyen a la ejecucion
 * real del verificador (que corre como gate dentro de `pnpm test` de este
 * paquete): fijan el contrato del parser tar binario fail-closed, del
 * inventario por hash de contenido, de las firmas semanticas por conjuncion
 * y del analisis estricto de package.json.
 */

// ---------------------------------------------------------------------------
// Constructor de tars sinteticos (validos e invalidos) para el parser binario
// ---------------------------------------------------------------------------

interface TarSpec {
  name: string;
  type?: string; // typeflag: '0' file, '5' dir, '2' symlink, '1' hardlink...
  content?: string | Buffer;
  linkname?: string;
  corruptChecksum?: boolean;
}

function tarHeader(spec: TarSpec, size: number): Buffer {
  const h = Buffer.alloc(512);
  h.write(spec.name, 0, 'utf8');
  h.write('0000644\0', 100, 'ascii'); // mode
  h.write('0000000\0', 108, 'ascii'); // uid
  h.write('0000000\0', 116, 'ascii'); // gid
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
  h.write('00000000000\0', 136, 'ascii'); // mtime
  h.write(spec.type ?? '0', 156, 'ascii');
  if (spec.linkname) h.write(spec.linkname, 157, 'utf8');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  // checksum: sobre el header con el campo checksum en blanco (spaces)
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i]!;
  if (spec.corruptChecksum) sum += 1;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return h;
}

function makeTar(specs: TarSpec[], terminatorBlocks = 2): Buffer {
  const parts: Buffer[] = [];
  for (const spec of specs) {
    const content =
      spec.content === undefined
        ? Buffer.alloc(0)
        : Buffer.isBuffer(spec.content)
          ? spec.content
          : Buffer.from(spec.content, 'utf8');
    // Los typeflags con DATA: fichero regular ('0') y extensiones PAX/GNU
    // ('x'/'g'/'L'/'K') — los tests de terminacion construyen extensiones
    // pendientes deliberadamente.
    const isData = ['0', 'x', 'g', 'L', 'K'].includes(spec.type ?? '0');
    const size = isData ? content.length : 0;
    parts.push(tarHeader(spec, size));
    if (isData && size > 0) {
      const padded = Math.ceil(size / 512) * 512;
      const block = Buffer.alloc(padded);
      content.copy(block);
      parts.push(block);
    }
  }
  parts.push(Buffer.alloc(512 * terminatorBlocks)); // terminador estricto: DOS bloques cero
  return Buffer.concat(parts);
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

// ---------------------------------------------------------------------------
// Parser tar binario FAIL-CLOSED
// ---------------------------------------------------------------------------

describe('parseTarEntries: parser binario fail-closed', () => {
  it('parsea ficheros, directorios, symlinks y hardlinks con sus targets', () => {
    const tar = makeTar([
      { name: 'app/package.json', content: '{"name":"x"}' },
      { name: 'app/apps/', type: '5' },
      { name: 'app/link.js', type: '2', linkname: '../packages/db/index.js' },
      { name: 'app/hard.js', type: '1', linkname: 'app/package.json' },
    ]);
    const entries = parseTarEntries(tar);
    expect(entries).toHaveLength(4);
    expect(entries[0]).toMatchObject({
      type: 'file',
      path: 'app/package.json',
      sha256: sha256('{"name":"x"}'),
    });
    expect(entries[1]).toMatchObject({ type: 'dir', path: 'app/apps' });
    expect(entries[2]).toMatchObject({
      type: 'symlink',
      path: 'app/link.js',
      linkTarget: '../packages/db/index.js',
    });
    expect(entries[3]).toMatchObject({
      type: 'hardlink',
      path: 'app/hard.js',
      linkTarget: 'app/package.json',
    });
  });

  it('captura contenido SOLO donde el predicado lo pide', () => {
    const tar = makeTar([
      { name: 'app/apps/api/x.js', content: 'const a = 1;' },
      { name: 'app/other.bin', content: 'zz' },
    ]);
    const entries = parseTarEntries(tar, (p) => p.endsWith('.js'));
    expect(entries[0]!.content?.toString()).toBe('const a = 1;');
    expect(entries[1]!.content).toBeUndefined();
    expect(entries[1]!.sha256).toBe(sha256('zz')); // hash SIEMPRE
  });

  it('FAIL-CLOSED: una entrada invalida seguida de una valida invalida TODO el archivo', () => {
    const good = { name: 'app/ok.js', content: 'ok' };
    const bad = { name: 'app/bad.js', content: 'x', corruptChecksum: true };
    // la invalida va PRIMERO: el parser debe abortar, no saltarsela y seguir
    expect(() => parseTarEntries(makeTar([bad, good]))).toThrow(TarFormatError);
    expect(() => parseTarEntries(makeTar([bad, good]))).toThrow(/checksum/);
    // control: las dos validas parsean
    expect(parseTarEntries(makeTar([good, { name: 'app/b.js', content: 'y' }]))).toHaveLength(2);
  });

  it('typeflag desconocido = fallo total (jamas se ignora la entrada)', () => {
    const tar = makeTar([{ name: 'app/x', type: 'Z' }]);
    expect(() => parseTarEntries(tar)).toThrow(/unknown tar typeflag/);
  });

  it('paths absolutos y con `..` = fallo (normalizacion fail-closed)', () => {
    expect(() => normalizeTarPath('/etc/passwd')).toThrow(TarFormatError);
    expect(() => normalizeTarPath('app/../../etc/passwd')).toThrow(/traversal/);
    expect(normalizeTarPath('./app/x/')).toBe('app/x');
    expect(normalizeTarPath('app/y')).toBe('app/y');
  });

  it('tar truncado (bloque parcial) o datos tras el terminador = fallo', () => {
    const good = makeTar([{ name: 'app/ok.js', content: 'ok' }]);
    expect(() => parseTarEntries(good.subarray(0, good.length - 1030))).toThrow(TarFormatError);
    const garbage = Buffer.concat([good, Buffer.from('extra')]);
    expect(() => parseTarEntries(garbage)).toThrow(/after tar terminator|truncated/);
  });
});

// ---------------------------------------------------------------------------
// Clasificacion de rutas y links
// ---------------------------------------------------------------------------

describe('isForbiddenImagePath / isForbiddenLinkTarget', () => {
  it.each([
    'app/packages/seeds',
    'app/packages/seeds/src/reset.ts',
    'app/node_modules/.pnpm/node_modules/@fluvia/seeds',
    'app/anywhere/run-reset.ts',
    'app/deep/nested/showroom.ts',
    'app/packages/seeds/src/.wh.seeds',
  ])('prohibida: %s', (path) => {
    expect(isForbiddenImagePath(path)).toBe(true);
  });

  it.each([
    'app/apps/api/package.json',
    'app/docs/agents/STATE.md',
    'app/packages/reconciliation/src/manifest-like.ts',
    'app/apps/dashboard/app/manifest.ts',
    'app/node_modules/some-dep/seeds.js',
    '',
  ])('inocua: %s', (path) => {
    expect(isForbiddenImagePath(path)).toBe(false);
  });

  it('links hacia seeds prohibidos', () => {
    expect(isForbiddenLinkTarget('../../../../packages/seeds')).toBe(true);
    expect(isForbiddenLinkTarget('../node_modules/@fluvia/seeds')).toBe(true);
    expect(isForbiddenLinkTarget('../@fluvia/db')).toBe(false);
    expect(isForbiddenLinkTarget(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Inventario por hash de contenido (copias renombradas, hardlinks)
// ---------------------------------------------------------------------------

describe('scanTarEntries: inventario SHA-256 del tooling', () => {
  const RESET_SOURCE = 'export async function runShowroomReset() { /* tooling */ }';
  const seedHashes = new Map([[sha256(RESET_SOURCE), 'packages/seeds/src/reset.ts']]);

  it('una COPIA RENOMBRADA del tooling (p. ej. /app/tools/reset-showroom.js) se detecta', () => {
    const tar = makeTar([{ name: 'app/tools/reset-showroom.js', content: RESET_SOURCE }]);
    const violations = scanTarEntries(parseTarEntries(tar, shouldCaptureContent), 'L', {
      seedHashes,
    });
    expect(violations.join('\n')).toContain(
      'app/tools/reset-showroom.js content-hash matches checkout packages/seeds/src/reset.ts'
    );
  });

  it('una copia bajo node_modules con nombre de dependencia inocua se detecta', () => {
    const tar = makeTar([{ name: 'app/node_modules/left-pad/index.bin', content: RESET_SOURCE }]);
    const violations = scanTarEntries(parseTarEntries(tar), 'L', { seedHashes });
    expect(violations.join('\n')).toContain('content-hash matches checkout');
  });

  it('un HARDLINK con nombre inocuo se resuelve a su contenido y se detecta', () => {
    const tar = makeTar([
      { name: 'app/data/blob.dat', content: RESET_SOURCE },
      { name: 'app/lib/utils.js', type: '1', linkname: 'app/data/blob.dat' },
    ]);
    const violations = scanTarEntries(parseTarEntries(tar), 'L', { seedHashes });
    const text = violations.join('\n');
    expect(text).toContain('app/data/blob.dat content-hash matches checkout');
    expect(text).toContain('app/lib/utils.js content-hash matches checkout');
  });

  it('hardlink con destino desconocido = violacion fail-closed (jamas se ignora)', () => {
    const tar = makeTar([{ name: 'app/x.js', type: '1', linkname: 'app/never-seen.dat' }]);
    const violations = scanTarEntries(parseTarEntries(tar), 'L', { seedHashes });
    expect(violations.join('\n')).toContain('unknown target (fail-closed)');
  });

  it('un symlink con nombre inocuo hacia seeds se delata SIN seguirlo', () => {
    const tar = makeTar([
      { name: 'app/lib/helper.js', type: '2', linkname: '../../packages/seeds/src/reset.ts' },
    ]);
    const violations = scanTarEntries(parseTarEntries(tar), 'L', { seedHashes });
    expect(violations.join('\n')).toContain('targets seeds tooling');
  });

  it('delta 3: el inventario aplica a TODO el filesystem — una copia FUERA de /app tambien delata', () => {
    const tar = makeTar([
      { name: 'app/apps/api/src/server.js', content: 'const s = 1;' },
      { name: 'etc/passwd-copy', content: RESET_SOURCE }, // fuera de app/: tambien detectada
    ]);
    const violations = scanTarEntries(parseTarEntries(tar), 'L', { seedHashes });
    expect(violations.join('\n')).toContain('etc/passwd-copy content-hash matches checkout');
    // Archivos limpios jamas disparan.
    expect(violations.filter((v) => v.includes('server.js'))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Firmas semanticas por CONJUNCION
// ---------------------------------------------------------------------------

describe('semanticSignatureViolation: conjunciones, jamas una palabra suelta', () => {
  it('>=2 marcadores especificos distintos = violacion', () => {
    expect(
      semanticSignatureViolation(
        'await runShowroomReset(x); throw new ShowroomTargetRemovedError()'
      )
    ).toEqual(['runShowroomReset', 'ShowroomTargetRemovedError']);
  });

  it('pares conjuntivos completos = violacion', () => {
    expect(semanticSignatureViolation('DROP DATABASE x; -- fluvia_showroom')).toEqual([
      'DROP DATABASE+fluvia_showroom',
    ]);
    expect(semanticSignatureViolation('run demo:reset then showroom:seed')).toEqual([
      'demo:reset+showroom:seed',
    ]);
  });

  it('UN solo marcador o media conjuncion NO dispara (sin palabra generica suelta)', () => {
    expect(semanticSignatureViolation('DROP DATABASE restore_drill')).toEqual([]);
    expect(semanticSignatureViolation('solo runShowroomReset aqui')).toEqual([]);
    expect(semanticSignatureViolation('const showroom = "sala de exposicion";')).toEqual([]);
    expect(semanticSignatureViolation('')).toEqual([]);
  });

  it('un SOURCE MAP con sourcesContent del reset se detecta via scan', () => {
    const map = JSON.stringify({
      version: 3,
      sources: ['../src/anything.ts'],
      sourcesContent: [
        'const c = "RESET_FLUVIA_SHOWROOM"; const u = process.env.SHOWROOM_MAINTENANCE_DATABASE_URL;',
      ],
    });
    const tar = makeTar([{ name: 'app/packages/db/dist/anything.js.map', content: map }]);
    const violations = scanTarEntries(parseTarEntries(tar, shouldCaptureContent), 'L');
    expect(violations.join('\n')).toContain('semantic signature');
  });

  it('el alcance es app/{apps,packages,scripts,node_modules} + extensiones codigo/metadata', () => {
    expect(isSemanticScanPath('app/apps/api/src/x.ts')).toBe(true);
    expect(isSemanticScanPath('app/node_modules/dep/index.js')).toBe(true);
    expect(isSemanticScanPath('app/scripts/x.mjs')).toBe(true);
    expect(isSemanticScanPath('app/packages/db/dist/x.js.map')).toBe(true);
    expect(isSemanticScanPath('app/docs/notas.md')).toBe(false); // fuera de alcance
    expect(isSemanticScanPath('app/apps/api/logo.png')).toBe(false); // no codigo
    expect(isSemanticScanPath('usr/lib/node/x.js')).toBe(false); // base layer
  });
});

// ---------------------------------------------------------------------------
// package.json ESTRICTO (fail-closed)
// ---------------------------------------------------------------------------

describe('packageJsonViolations: fail-closed, jamas lista vacia por parseo roto', () => {
  it('JSON invalido en un manifiesto workspace = violacion (no [])', () => {
    expect(packageJsonViolations('not json {', 'app/package.json')).toEqual([
      'app/package.json: invalid JSON in package.json (fail-closed)',
    ]);
  });

  it('scripts no-objeto = violacion', () => {
    expect(
      packageJsonViolations(JSON.stringify({ scripts: 'echo hi' }), 'app/packages/db/package.json')
    ).toContain('app/packages/db/package.json: scripts is not an object (fail-closed)');
  });

  it('scripts prohibidos en un manifiesto workspace = violacion', () => {
    const pkg = JSON.stringify({ scripts: { seed: 'x', 'demo:reset': 'y', build: 'ok' } });
    const violations = packageJsonViolations(pkg, 'app/package.json');
    expect(violations.join('\n')).toContain('forbidden script "seed"');
    expect(violations.join('\n')).toContain('forbidden script "demo:reset"');
  });

  it('metadata que RESUELVE @fluvia/seeds = violacion (deps, name, workspaces, pnpm)', () => {
    expect(
      packageJsonViolations(
        JSON.stringify({ dependencies: { '@fluvia/seeds': 'workspace:*' } }),
        'app/apps/api/package.json'
      ).join('\n')
    ).toContain('dependencies resolves @fluvia/seeds');
    expect(
      packageJsonViolations(
        JSON.stringify({ name: '@fluvia/seeds' }),
        'app/node_modules/innocent/package.json'
      ).join('\n')
    ).toContain('package name is @fluvia/seeds');
  });

  it('un script `seed` PROPIO de una dependencia ajena NO es nuestro tooling', () => {
    const pkg = JSON.stringify({ name: 'faker', scripts: { seed: 'faker seed' } });
    expect(packageJsonViolations(pkg, 'app/node_modules/faker/package.json')).toEqual([]);
  });

  it('fixture ANIDADO de un tercero: JSON invalido = fallo (delta 3, jamas se acepta)', () => {
    expect(
      packageJsonViolations('broken json', 'app/node_modules/dep/test/fixtures/package.json')
    ).toEqual([
      'app/node_modules/dep/test/fixtures/package.json: invalid JSON in package.json (fail-closed)',
    ]);
    expect(
      packageJsonViolations(
        '{"dependencies":{"@fluvia/seeds":"*"}}',
        'app/node_modules/dep/test/fixtures/package.json'
      ).join('\n')
    ).toContain('dependencies resolves @fluvia/seeds');
  });

  it('manifestKindForPath clasifica workspace/dependency/nested', () => {
    expect(manifestKindForPath('app/package.json')).toBe('workspace');
    expect(manifestKindForPath('app/apps/api/package.json')).toBe('workspace');
    expect(manifestKindForPath('app/node_modules/pg/package.json')).toBe('dependency');
    expect(manifestKindForPath('app/node_modules/@scope/x/package.json')).toBe('dependency');
    expect(manifestKindForPath('app/node_modules/pg/test/package.json')).toBe('nested');
    expect(manifestKindForPath('app/apps/api/src/server.ts')).toBe(null);
    expect(FORBIDDEN_SCRIPTS).toEqual(['seed', 'showroom:seed', 'demo:reset']);
  });
});

// ---------------------------------------------------------------------------
// Residuos de secretos y redaccion de logs
// ---------------------------------------------------------------------------

describe('residuos /run/secrets y redaccion', () => {
  it('scanTarEntries delata residuos de /run/secrets', () => {
    const tar = makeTar([{ name: 'run/secrets/fluvia_build_ca', content: 'PEM' }]);
    expect(scanTarEntries(parseTarEntries(tar), 'layer-y')).toEqual([
      'layer-y: /run/secrets residue run/secrets/fluvia_build_ca',
    ]);
  });

  it('la CA se detecta por hash y aguja en CUALQUIER path del filesystem (delta 3)', () => {
    const ca = '-----BEGIN CERTIFICATE-----\nAAAABBBBCCCC\n-----END CERTIFICATE-----\n';
    const caSha = sha256(ca);
    const needle = Buffer.from('AAAABBBBCCCC', 'utf8');
    const tar = makeTar([
      // FUERA de /app: /usr, /etc y un hardlink hacia la CA.
      { name: 'usr/local/share/ca-certificates/fluvia.crt', content: ca },
      { name: 'etc/ssl/certs/extra.pem', content: ca },
      { name: 'etc/motd', content: `welcome AAAABBBBCCCC bye` },
      { name: 'home/node/link-to-ca', type: '1', linkname: 'etc/ssl/certs/extra.pem' },
      { name: 'app/apps/api/src/embed.ts', content: `const pem = "AAAABBBBCCCC";` },
    ]);
    const violations = scanTarEntries(parseTarEntries(tar, shouldCaptureContent, { needle }), 'L', {
      caSha256: caSha,
    });
    const text = violations.join('\n');
    expect(text).toContain(
      'usr/local/share/ca-certificates/fluvia.crt content-hash matches the build CA'
    );
    expect(text).toContain('etc/ssl/certs/extra.pem content-hash matches the build CA');
    expect(text).toContain('etc/motd embeds build CA material'); // texto fuera de /app
    expect(text).toContain('home/node/link-to-ca content-hash matches the build CA'); // hardlink
    expect(text).toContain('app/apps/api/src/embed.ts embeds build CA material');
  });

  it('imagen SIN CA: cero falsos positivos de CA', () => {
    const tar = makeTar([{ name: 'usr/share/doc/readme', content: 'hello world' }]);
    const violations = scanTarEntries(parseTarEntries(tar), 'L', { caSha256: null });
    expect(violations).toEqual([]);
  });

  it('redactForLog elimina URLs con credenciales y material password', () => {
    const out = redactForLog(
      'connect postgres://user:secret-pw@10.0.0.1/db failed password=abc123'
    );
    expect(out).not.toContain('secret-pw');
    expect(out).not.toContain('abc123');
    expect(out).toContain('<redacted-url>');
  });
});

// ---------------------------------------------------------------------------
// Delta 3 — tar strict terminator PASS
// ---------------------------------------------------------------------------

describe('tar strict terminator PASS (delta 3: doble bloque cero obligatorio)', () => {
  const entry = { name: 'app/ok.js', content: 'ok' };

  it('sin terminador (EOF tras la ultima entrada) = fallo', () => {
    expect(() => parseTarEntries(makeTar([entry], 0))).toThrow(/terminator|truncated/);
  });

  it('UN solo bloque cero = fallo', () => {
    expect(() => parseTarEntries(makeTar([entry], 1))).toThrow(TarFormatError);
    expect(() => parseTarEntries(makeTar([entry], 1))).toThrow(/single zero block|EOF between/);
  });

  it('DOS bloques cero = valido; TRES (padding extra cero) = valido', () => {
    expect(parseTarEntries(makeTar([entry], 2))).toHaveLength(1);
    expect(parseTarEntries(makeTar([entry], 3))).toHaveLength(1);
  });

  it('segundo bloque PARCIAL (EOF entre terminadores) = fallo', () => {
    const tar = Buffer.concat([makeTar([entry], 1), Buffer.alloc(100)]);
    expect(() => parseTarEntries(tar)).toThrow(/EOF between tar terminator blocks/);
  });

  it('dato no-cero DESPUES del segundo bloque = fallo', () => {
    const tar = Buffer.concat([makeTar([entry], 2), Buffer.alloc(511), Buffer.from([0x41])]);
    expect(() => parseTarEntries(tar)).toThrow(/after tar terminator/);
  });

  it('PAX pendiente al llegar el terminador = fallo', () => {
    const pax = { name: 'pax', type: 'x', content: '17 path=app/x.js\n' };
    expect(() => parseTarEntries(makeTar([entry, pax], 2))).toThrow(/pending PAX\/GNU extension/);
  });

  it('GNU longname pendiente al llegar el terminador = fallo', () => {
    const longname = { name: 'gnu', type: 'L', content: 'app/very-long-name.js\0' };
    expect(() => parseTarEntries(makeTar([entry, longname], 2))).toThrow(
      /pending PAX\/GNU extension/
    );
  });

  it('archivo VACIO = fallo (cero terminadores)', () => {
    expect(() => parseTarEntries(Buffer.alloc(0))).toThrow(/terminator|truncated/);
  });

  it('header PARCIAL (menos de 512 bytes) = fallo', () => {
    expect(() => parseTarEntries(Buffer.alloc(300))).toThrow(/terminator|truncated/);
  });
});

// ---------------------------------------------------------------------------
// Delta 3 — package aliases PASS (metadata EXACTA, clave y VALOR)
// ---------------------------------------------------------------------------

describe('package aliases PASS (delta 3: aliases npm:/workspace:/file:/link: y workspaces exactos)', () => {
  it.each([
    ['clave directa', '@fluvia/seeds', 'workspace:*'],
    ['alias npm', 'innocent', 'npm:@fluvia/seeds@1.0.0'],
    ['alias npm sin version', 'innocent', 'npm:@fluvia/seeds'],
    ['alias workspace', 'innocent', 'workspace:@fluvia/seeds@*'],
    ['alias file', 'innocent', 'file:../../packages/seeds'],
    ['alias link', 'innocent', 'link:packages/seeds'],
  ])('%s => resuelve @fluvia/seeds', (_label, name, spec) => {
    expect(dependencySpecResolvesFluviaSeeds(name, spec)).toBe(true);
  });

  it.each([
    ['paquete parecido', '@example/seeds', '1.0.0'],
    ['alias hacia otro paquete', 'x', 'npm:@fluvia/db@1.0.0'],
    ['file hacia oilseeds', 'x', 'file:../../packages/oilseeds'],
    ['file hacia un sub-path de seeds', 'x', 'file:packages/seeds-helper'],
    ['nombre con substring', 'some-seeds-helper', '2.0.0'],
    ['version normal', 'left-pad', '^1.3.0'],
  ])('%s => NO resuelve', (_label, name, spec) => {
    expect(dependencySpecResolvesFluviaSeeds(name, spec)).toBe(false);
  });

  it('workspaces: patrones que PUEDEN resolver packages/seeds', () => {
    expect(workspacePatternCanResolveFluviaSeeds('packages/seeds')).toBe(true);
    expect(workspacePatternCanResolveFluviaSeeds('packages/*')).toBe(true);
    expect(workspacePatternCanResolveFluviaSeeds('**')).toBe(true);
    expect(workspacePatternCanResolveFluviaSeeds('packages/se*')).toBe(true);
  });

  it('workspaces: negativos exactos (sin substring ciego)', () => {
    expect(workspacePatternCanResolveFluviaSeeds('packages/oilseeds')).toBe(false);
    expect(workspacePatternCanResolveFluviaSeeds('packages/seeds-extra')).toBe(false);
    expect(workspacePatternCanResolveFluviaSeeds('apps/*')).toBe(false);
    expect(workspacePatternCanResolveFluviaSeeds('tools/seeds')).toBe(false);
  });

  it('package.json: alias en el VALOR delata; override y resolution tambien', () => {
    const alias = JSON.stringify({ dependencies: { innocent: 'npm:@fluvia/seeds@1.0.0' } });
    expect(packageJsonViolations(alias, 'app/apps/api/package.json').join('\n')).toContain(
      'dependencies resolves @fluvia/seeds (innocent)'
    );
    const override = JSON.stringify({ overrides: { x: 'npm:@fluvia/seeds@2' } });
    expect(packageJsonViolations(override, 'app/package.json').join('\n')).toContain(
      'overrides resolves @fluvia/seeds'
    );
    const resolution = JSON.stringify({ resolutions: { '@fluvia/seeds': '1.0.0' } });
    expect(packageJsonViolations(resolution, 'app/package.json').join('\n')).toContain(
      'resolutions resolves @fluvia/seeds'
    );
    const pnpmOverride = JSON.stringify({ pnpm: { overrides: { y: 'workspace:@fluvia/seeds' } } });
    expect(packageJsonViolations(pnpmOverride, 'app/package.json').join('\n')).toContain(
      'pnpm.overrides resolves @fluvia/seeds'
    );
  });

  it('workspaces packages/* delata; packages/oilseeds como DEPENDENCIA no', () => {
    const ws = JSON.stringify({ workspaces: ['packages/*'] });
    expect(packageJsonViolations(ws, 'app/package.json').join('\n')).toContain(
      'workspaces pattern can resolve packages/seeds'
    );
    const innocent = JSON.stringify({
      workspaces: ['packages/oilseeds'],
      dependencies: { oilseeds: 'file:packages/oilseeds' },
    });
    expect(packageJsonViolations(innocent, 'app/package.json')).toEqual([]);
  });

  it('metadata inesperada = fallo (dependencies string, workspaces objeto raro, scripts string)', () => {
    expect(
      packageJsonViolations(JSON.stringify({ dependencies: 'oops' }), 'app/package.json').join('\n')
    ).toContain('dependencies is not an object (fail-closed)');
    expect(
      packageJsonViolations(JSON.stringify({ workspaces: 42 }), 'app/package.json').join('\n')
    ).toContain('workspaces has an unexpected shape (fail-closed)');
    expect(
      packageJsonViolations(JSON.stringify({ scripts: 'echo' }), 'app/package.json').join('\n')
    ).toContain('scripts is not an object (fail-closed)');
  });
});

// ---------------------------------------------------------------------------
// Delta 3 — transformed-content scan PASS (fingerprint lexico canonico)
// ---------------------------------------------------------------------------

describe('transformed-content scan PASS (delta 3: copias minificadas/transpiladas/renombradas)', () => {
  const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '../src');
  const liveIdentity = readFileSync(join(SRC_DIR, 'live-identity.ts'), 'utf8');
  const resetSource = readFileSync(join(SRC_DIR, 'reset.ts'), 'utf8');
  const inventory = buildLexicalInventory([
    { path: 'packages/seeds/src/live-identity.ts', text: liveIdentity },
    { path: 'packages/seeds/src/reset.ts', text: resetSource },
  ]);

  /** Minificacion de whitespace REAL: colapsa todo whitespace fuera de strings. */
  const whitespaceMinify = (source: string) => canonicalTokensJoin(source);
  function canonicalTokensJoin(source: string): string {
    // reconstruye un "minificado" plausible: tokens del fuente unidos por un
    // espacio (comillas normalizadas a dobles para strings)
    return canonicalTokens(source)
      .map((t) => (t.startsWith('S:') ? JSON.stringify(t.slice(2)) : t))
      .join(' ');
  }

  it('canonicalTokens/lexicalFingerprint: whitespace, comentarios y comillas NO cambian el stream', () => {
    const a = `const x = 'hola'; // comentario\nfunction f( a , b ) { return a + b; }`;
    const b = `/* otro */ const x="hola";function f(a,b){return a+b;}`;
    expect(lexicalFingerprint(a)).toBe(lexicalFingerprint(b));
    expect(canonicalTokens(a)).toEqual(canonicalTokens(b));
  });

  it('TOKEN_SEPARATOR: fronteras de tokens DISTINTAS jamas colisionan en el fingerprint', () => {
    // Un separador de ESPACIO seria ambiguo: un literal con espacio interno
    // (["S:a b"]) y un literal mas un identificador (["S:a","b"]) producirian
    // exactamente la misma cadena unida. El separador NUL (expresado como
    // escape textual, no como byte literal) no puede aparecer dentro de un
    // token canonico, asi que streams distintos JAMAS colisionan.
    const oneLiteral = `'a b'`;
    const literalPlusIdent = `'a' b`;
    expect(canonicalTokens(oneLiteral)).not.toEqual(canonicalTokens(literalPlusIdent));
    expect(canonicalTokens(oneLiteral).join(' ')).toBe(canonicalTokens(literalPlusIdent).join(' '));
    expect(lexicalFingerprint(oneLiteral)).not.toBe(lexicalFingerprint(literalPlusIdent));
    // Fronteras distintas entre identificadores tampoco colisionan.
    expect(lexicalFingerprint('ab c')).not.toBe(lexicalFingerprint('a bc'));
  });

  it('copia WHITESPACE-MINIFIED de live-identity.ts: detectada', () => {
    const minified = whitespaceMinify(liveIdentity);
    expect(minified.length).toBeLessThan(liveIdentity.length); // es una transformacion real
    expect(matchesLexicalScreen(minified, inventory)).toBe(true);
    const verdict = transformedCopyViolation(minified, inventory);
    expect(verdict).toContain('live-identity.ts');
  });

  it('copia SIN comentarios de linea y re-indentada: detectada (fingerprint identico)', () => {
    const stripped = liveIdentity
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/\n{2,}/g, '\n')
      .replace(/^[ \t]+/gm, '');
    expect(stripped).not.toBe(liveIdentity);
    const verdict = transformedCopyViolation(stripped, inventory);
    expect(verdict).toContain('live-identity.ts');
  });

  it('transpilacion TypeScript->JavaScript REAL de live-identity.ts: detectada', () => {
    const js = ts.transpileModule(liveIdentity, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    expect(js).not.toBe(liveIdentity);
    const verdict = transformedCopyViolation(js, inventory);
    expect(verdict).toContain('live-identity.ts');
  });

  it('source map con sourcesContent MINIFICADO del reset: detectado via scan', () => {
    const map = JSON.stringify({
      version: 3,
      sources: ['anything.ts'],
      sourcesContent: [whitespaceMinify(resetSource)],
    });
    const tar = makeTar([{ name: 'app/packages/db/dist/x.js.map', content: map }]);
    const violations = scanTarEntries(parseTarEntries(tar, shouldCaptureContent), 'L', {
      lexicalInventory: inventory,
    });
    expect(violations.join('\n')).toContain('transformed copy of checkout');
  });

  it('source map con JSON INVALIDO o sourcesContent no-array = fallo', () => {
    const bad = makeTar([{ name: 'app/apps/api/dist/x.js.map', content: 'not json {' }]);
    expect(scanTarEntries(parseTarEntries(bad, shouldCaptureContent), 'L').join('\n')).toContain(
      'invalid JSON in source map (fail-closed)'
    );
    const badShape = makeTar([
      {
        name: 'app/apps/api/dist/y.js.map',
        content: JSON.stringify({ version: 3, sourcesContent: 'nope' }),
      },
    ]);
    expect(
      scanTarEntries(parseTarEntries(badShape, shouldCaptureContent), 'L').join('\n')
    ).toContain('sourcesContent is not an array (fail-closed)');
  });

  it('dos archivos inocuos con una palabra comun NO disparan', () => {
    const innocentA = `export function connect() { return 'postgres://localhost'; }`;
    const innocentB = `const label = 'showroom'; console.log(label);`;
    expect(transformedCopyViolation(innocentA, inventory)).toBeNull();
    expect(transformedCopyViolation(innocentB, inventory)).toBeNull();
  });

  it('extractStringLiterals: literales significativas, sin duplicados', () => {
    const lits = extractStringLiterals(
      `const a = 'literal-uno-larga'; const b = "literal-uno-larga"; const c = 'x';`
    );
    expect(lits.has('literal-uno-larga')).toBe(true);
    expect(lits.has('x')).toBe(false); // demasiado corta
    expect(lits.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Delta 3 — stdout/stderr bounds PASS (procesos REALES, limites en bytes)
// ---------------------------------------------------------------------------

describe('stdout/stderr bounds PASS (delta 3: overflow fail-closed con procesos reales)', () => {
  const LIMIT = 64 * 1024; // limite pequeno para tests

  it('stdout excesivo + exit 0 = fallo (jamas success con output truncado)', async () => {
    await expect(
      runBoundedProcess(
        'node',
        ['-e', `process.stdout.write('x'.repeat(${LIMIT * 4})); process.exit(0)`],
        { timeoutMs: 30_000, outputLimitBytes: LIMIT }
      )
    ).rejects.toThrow(/exceeded the output byte limit/);
  });

  it('stderr excesivo + exit 0 = fallo (misma politica que stdout)', async () => {
    await expect(
      runBoundedProcess(
        'node',
        ['-e', `process.stderr.write('e'.repeat(${LIMIT * 4})); process.exit(0)`],
        { timeoutMs: 30_000, outputLimitBytes: LIMIT }
      )
    ).rejects.toThrow(/exceeded the output byte limit/);
  });

  it('ambos streams excesivos = fallo con error FIJO sanitizado (sin el output)', async () => {
    let message = '';
    try {
      await runBoundedProcess(
        'node',
        [
          '-e',
          `process.stdout.write('S'.repeat(${LIMIT * 2})); process.stderr.write('E'.repeat(${LIMIT * 2}));`,
        ],
        { timeoutMs: 30_000, outputLimitBytes: LIMIT }
      );
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('exceeded the output byte limit');
    expect(message).not.toContain('SSSS');
    expect(message).not.toContain('EEEE');
  });

  it('output JUSTO BAJO el limite = exito', async () => {
    const { stdout } = await runBoundedProcess(
      'node',
      ['-e', `process.stdout.write('x'.repeat(${LIMIT - 1024}))`],
      { timeoutMs: 30_000, outputLimitBytes: LIMIT }
    );
    expect(stdout).toHaveLength(LIMIT - 1024);
  });

  it('el limite se mide en BYTES, no en longitud UTF-16', async () => {
    // 'é' = 2 bytes UTF-8: LIMIT*0.75 caracteres exceden LIMIT bytes.
    const chars = Math.floor(LIMIT * 0.75);
    await expect(
      runBoundedProcess('node', ['-e', `process.stdout.write('\\u00e9'.repeat(${chars}))`], {
        timeoutMs: 30_000,
        outputLimitBytes: LIMIT,
      })
    ).rejects.toThrow(/exceeded the output byte limit/);
  });

  it('proceso que IGNORA SIGTERM y deja un NIETO: el process group muere igual (SIGKILL)', async () => {
    const pidFile = join(tmpdir(), `.fluvia-tmp-grandchild-${process.pid}`);
    await expect(
      runBoundedProcess(
        'sh',
        [
          '-c',
          `trap '' TERM; sleep 300 & echo $! > ${JSON.stringify(pidFile)}; while true; do echo flood; done`,
        ],
        { timeoutMs: 60_000, outputLimitBytes: LIMIT }
      )
    ).rejects.toThrow(/exceeded the output byte limit/);
    // el nieto (sleep) tambien murio con el grupo (SIGKILL groupwide). Un
    // proceso ZOMBIE sin reapear cuenta como muerto: kill(pid,0) responderia
    // exito para un zombie, asi que se lee el ESTADO real de /proc.
    const grandchild = Number(readFileSync(pidFile, 'utf8').trim());
    await new Promise((r) => setTimeout(r, 200));
    let state = 'gone';
    try {
      const stat = readFileSync(`/proc/${grandchild}/stat`, 'utf8');
      state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] ?? 'gone';
    } catch {
      state = 'gone';
    }
    expect(['gone', 'Z', 'X']).toContain(state);
    spawnSync('rm', ['-f', pidFile]);
  });

  it('timeout con proceso SILENCIOSO: fallo por timeout con grupo matado', async () => {
    await expect(
      runBoundedProcess('sleep', ['300'], { timeoutMs: 1_000, outputLimitBytes: LIMIT })
    ).rejects.toThrow(/timed out .* \(group killed\)/);
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Delta 3 — Docker cleanup verification PASS (tracker tipado con verificacion)
// ---------------------------------------------------------------------------

describe('Docker cleanup verification PASS (delta 3: tracker con verificacion por inspect)', () => {
  type Exec = (args: string[], timeoutMs: number) => Promise<unknown>;

  function scriptedExec(script: {
    removeFails?: Set<string>;
    stillExists?: Set<string>;
    calls?: string[][];
  }): Exec {
    return async (args) => {
      script.calls?.push(args);
      const id = args[args.length - 1]!;
      const isInspect = args.includes('inspect');
      if (isInspect) {
        if (script.stillExists?.has(id)) return 'exists';
        throw new Error('No such object');
      }
      if (script.removeFails?.has(id)) throw new Error('cannot remove');
      return '';
    };
  }

  it('rm falla pero el recurso YA NO existe: aceptable (verificado ausente)', async () => {
    const tracker = createDockerCleanupTracker(
      scriptedExec({ removeFails: new Set(['c1']), stillExists: new Set() })
    );
    tracker.register('container', 'c1');
    const result = await tracker.cleanupAll();
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('rm falla y el recurso SIGUE existiendo: cleanup FAILED', async () => {
    const tracker = createDockerCleanupTracker(
      scriptedExec({ removeFails: new Set(['c1']), stillExists: new Set(['c1']) })
    );
    tracker.register('container', 'c1', 'api');
    const result = await tracker.cleanupAll();
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([{ kind: 'container', label: 'api' }]);
  });

  it('rmi y network rm fallidos con recursos vivos: DOS failures reportados', async () => {
    const tracker = createDockerCleanupTracker(
      scriptedExec({
        removeFails: new Set(['img1', 'net1']),
        stillExists: new Set(['img1', 'net1']),
      })
    );
    tracker.register('image', 'img1');
    tracker.register('network', 'net1');
    tracker.register('container', 'ok1');
    const result = await tracker.cleanupAll();
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(2);
  });

  it('un recurso NO creado no es failure; removeNow verifica de inmediato', async () => {
    const calls: string[][] = [];
    const tracker = createDockerCleanupTracker(scriptedExec({ calls }));
    tracker.register('container', 'c1');
    expect(await tracker.removeNow('container', 'c1')).toBe(true);
    // segunda pasada: ya no esta 'created', no se re-intenta
    const result = await tracker.cleanupAll();
    expect(result.ok).toBe(true);
    const rmCalls = calls.filter((c) => c[0] === 'rm');
    expect(rmCalls).toHaveLength(1);
  });

  it('cleanup PASS es IMPOSIBLE con un recurso vivo (resumen tipado)', async () => {
    const tracker = createDockerCleanupTracker(
      scriptedExec({ removeFails: new Set(['v1']), stillExists: new Set(['v1']) })
    );
    tracker.register('volume', 'v1');
    const result = await tracker.cleanupAll();
    expect(result.ok).toBe(false);
    expect(result.summary.join(',')).toContain('volume:v1=cleanup_failed');
  });
});
