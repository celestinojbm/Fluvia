import { createHash } from 'node:crypto';
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

function makeTar(specs: TarSpec[]): Buffer {
  const parts: Buffer[] = [];
  for (const spec of specs) {
    const content =
      spec.content === undefined
        ? Buffer.alloc(0)
        : Buffer.isBuffer(spec.content)
          ? spec.content
          : Buffer.from(spec.content, 'utf8');
    const isData = (spec.type ?? '0') === '0';
    const size = isData ? content.length : 0;
    parts.push(tarHeader(spec, size));
    if (isData && size > 0) {
      const padded = Math.ceil(size / 512) * 512;
      const block = Buffer.alloc(padded);
      content.copy(block);
      parts.push(block);
    }
  }
  parts.push(Buffer.alloc(1024)); // terminador: dos bloques cero
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

  it('archivos limpios bajo app/ y archivos FUERA de app/ no disparan', () => {
    const tar = makeTar([
      { name: 'app/apps/api/src/server.js', content: 'const s = 1;' },
      { name: 'etc/passwd-copy', content: RESET_SOURCE }, // fuera de app/: base layer
    ]);
    const violations = scanTarEntries(parseTarEntries(tar), 'L', { seedHashes });
    expect(violations.filter((v) => v.includes('content-hash'))).toHaveLength(0);
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

  it('fixture anidado de un tercero: solo la referencia a @fluvia/seeds delata', () => {
    expect(
      packageJsonViolations('broken json', 'app/node_modules/dep/test/fixtures/package.json')
    ).toEqual([]);
    expect(
      packageJsonViolations(
        '{"dependencies":{"@fluvia/seeds":"*"}}',
        'app/node_modules/dep/test/fixtures/package.json'
      ).join('\n')
    ).toContain('references @fluvia/seeds');
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

  it('la CA de build se detecta por hash y por aguja textual', () => {
    const ca = '-----BEGIN CERTIFICATE-----\nAAAABBBBCCCC\n-----END CERTIFICATE-----\n';
    const caSha = sha256(ca);
    const tar = makeTar([
      { name: 'app/etc/rogue-ca.crt', content: ca },
      { name: 'app/apps/api/src/embed.ts', content: `const pem = "AAAABBBBCCCC";` },
    ]);
    const violations = scanTarEntries(parseTarEntries(tar, shouldCaptureContent), 'L', {
      caSha256: caSha,
      caNeedle: 'AAAABBBBCCCC',
    });
    expect(violations.join('\n')).toContain('content-hash matches the build CA');
    expect(violations.join('\n')).toContain('embeds build CA material');
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
