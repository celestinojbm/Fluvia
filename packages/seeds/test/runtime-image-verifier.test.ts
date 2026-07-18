import { describe, expect, it } from 'vitest';
import {
  FORBIDDEN_SCRIPTS,
  forbiddenScriptsIn,
  isForbiddenImagePath,
  isForbiddenLinkTarget,
  isWorkspaceManifestPath,
  normalizeTarPath,
  parseTarListing,
  scanEntries,
} from '../../../scripts/verify-runtime-image.mjs';

/**
 * RA-F65C3-EXT-007 — helpers PUROS del verificador dinamico de la imagen
 * runtime (`pnpm runtime:image:verify`). Estos tests NO sustituyen a la
 * ejecucion real del verificador (build canonico + analisis de capas): solo
 * fijan el contrato de clasificacion — que rutas/symlinks/scripts son tooling
 * EJECUTABLE prohibido y que es una referencia textual inocua.
 */

describe('isForbiddenImagePath: rutas de tooling vs referencias inocuas', () => {
  it.each([
    'app/packages/seeds',
    'app/packages/seeds/src/reset.ts',
    'app/packages/seeds/package.json',
    './app/packages/seeds/src/manifest.ts',
    'app/node_modules/.pnpm/node_modules/@fluvia/seeds',
    'app/node_modules/@fluvia/seeds/package.json',
    'app/anywhere/run-reset.ts',
    'app/anywhere/run-showroom.ts',
    'app/deep/nested/showroom.ts',
    'app/packages/seeds/src/.wh.seeds',
  ])('prohibida: %s', (path) => {
    expect(isForbiddenImagePath(path)).toBe(true);
  });

  it.each([
    'app/apps/api/package.json',
    'app/apps/worker/src/index.ts',
    'app/docs/agents/STATE.md', // documentacion que MENCIONA seeds: inocua
    'app/packages/db/src/migrate.ts',
    'app/packages/reconciliation/src/manifest-like.ts',
    'app/apps/dashboard/app/manifest.ts', // manifest.ts FUERA de seeds: valido
    'app/node_modules/some-dep/seeds.js', // dep ajena con nombre parecido
    'app/scripts/verify-runtime-image.mjs',
    '',
  ])('inocua: %s', (path) => {
    expect(isForbiddenImagePath(path)).toBe(false);
  });

  it('normalizeTarPath: ./, / y trailing slash', () => {
    expect(normalizeTarPath('./app/x/')).toBe('app/x');
    expect(normalizeTarPath('/app/x')).toBe('app/x');
  });
});

describe('symlinks y listado tar', () => {
  it('detecta symlinks hacia el tooling de seeds', () => {
    expect(isForbiddenLinkTarget('../../../../packages/seeds')).toBe(true);
    expect(isForbiddenLinkTarget('../node_modules/@fluvia/seeds')).toBe(true);
    expect(isForbiddenLinkTarget('../@fluvia/db')).toBe(false);
    expect(isForbiddenLinkTarget(null)).toBe(false);
  });

  it('parseTarListing: ficheros, directorios y symlinks con target', () => {
    const listing = [
      '-rw-r--r-- root/root      1234 2026-07-18 03:00 app/package.json',
      'drwxr-xr-x root/root         0 2026-07-18 03:00 app/apps/api/',
      'lrwxrwxrwx root/root         0 2026-07-18 03:00 app/node_modules/@fluvia/db -> ../../packages/db',
      'lrwxrwxrwx root/root         0 2026-07-18 03:00 app/nm/@fluvia/seeds -> ../../../../packages/seeds',
    ].join('\n');
    const entries = parseTarListing(listing);
    expect(entries).toHaveLength(4);
    expect(entries[0]).toEqual({ type: '-', path: 'app/package.json', linkTarget: null });
    expect(entries[1]!.type).toBe('d');
    expect(entries[2]).toEqual({
      type: 'l',
      path: 'app/node_modules/@fluvia/db',
      linkTarget: '../../packages/db',
    });
    const violations = scanEntries(entries, 'layer-x');
    expect(violations).toHaveLength(2); // ruta @fluvia/seeds + symlink a seeds
    expect(violations.join('\n')).toContain('symlink');
  });

  it('scanEntries delata residuos de /run/secrets', () => {
    const entries = parseTarListing(
      '-rw------- root/root        42 2026-07-18 03:00 run/secrets/fluvia_build_ca'
    );
    expect(scanEntries(entries, 'layer-y')).toEqual([
      'layer-y: /run/secrets residue run/secrets/fluvia_build_ca',
    ]);
  });
});

describe('package.json de workspace y scripts prohibidos', () => {
  it('solo cuenta manifests de WORKSPACE (no node_modules)', () => {
    expect(isWorkspaceManifestPath('app/package.json')).toBe(true);
    expect(isWorkspaceManifestPath('app/apps/api/package.json')).toBe(true);
    expect(isWorkspaceManifestPath('app/packages/db/package.json')).toBe(true);
    expect(isWorkspaceManifestPath('app/node_modules/pg/package.json')).toBe(false);
    expect(isWorkspaceManifestPath('app/apps/api/src/package.json.md')).toBe(false);
  });

  it('un package.json de dependencia ajena con script "seed" NO es nuestro tooling', () => {
    // …porque isWorkspaceManifestPath ya lo excluye; y forbiddenScriptsIn solo
    // reporta los scripts EXACTOS del tooling local.
    expect(forbiddenScriptsIn(JSON.stringify({ scripts: { seed: 'faker seed' } }))).toEqual([
      'seed',
    ]);
    expect(isWorkspaceManifestPath('app/node_modules/faker/package.json')).toBe(false);
  });

  it('detecta los tres scripts prohibidos como ejecutables', () => {
    const pkg = {
      scripts: {
        seed: 'pnpm --filter @fluvia/seeds run seed',
        'showroom:seed': 'x',
        'demo:reset': 'y',
        build: 'turbo run build',
      },
    };
    expect(forbiddenScriptsIn(JSON.stringify(pkg))).toEqual(FORBIDDEN_SCRIPTS);
    expect(forbiddenScriptsIn(JSON.stringify({ scripts: { build: 'ok' } }))).toEqual([]);
    expect(forbiddenScriptsIn('not json at all')).toEqual([]);
  });
});
