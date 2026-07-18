import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * F6.5C3 / RA-F65C3-EXT-002 — regresion ESTATICA del Dockerfile: el tooling de
 * seeds se poda en una etapa INTERMEDIA (`runtime-pruned`, jamas exportada) y
 * la etapa final `runtime` parte de `base` copiando UNICAMENTE el snapshot ya
 * podado. El patron inseguro (COPY completo desde build + rm posterior) dejaba
 * el codigo recuperable en una capa OCI inferior y esta PROHIBIDO.
 *
 * NO sustituye al verificador dinamico (`pnpm runtime:image:verify`): ese
 * construye la imagen real e inspecciona el filesystem merged y TODAS las
 * capas del manifiesto. Esto solo impide una regresion silenciosa del texto.
 */

const DOCKERFILE_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../../Dockerfile');
const dockerfile = () => readFileSync(DOCKERFILE_PATH, 'utf8');

function stage(name: string): string {
  const text = dockerfile();
  const start = text.indexOf(`AS ${name}\n`);
  expect(start, `stage ${name} exists`).toBeGreaterThan(-1);
  const lineStart = text.lastIndexOf('FROM', start);
  const next = text.indexOf('\nFROM ', start);
  return text.slice(lineStart, next === -1 ? undefined : next);
}

describe('Dockerfile: pruning del tooling showroom ANTES de la copia final (OCI)', () => {
  it('existe la etapa intermedia runtime-pruned (FROM build) y poda seeds + symlinks + scripts', () => {
    const pruned = stage('runtime-pruned');
    expect(pruned).toContain('FROM build AS runtime-pruned');
    expect(pruned).toContain('rm -rf /app/packages/seeds');
    // symlinks del workspace hacia @fluvia/seeds (node_modules/.pnpm incluidos)
    expect(pruned).toContain('/app/node_modules/.pnpm/node_modules/@fluvia/seeds');
    expect(pruned).toMatch(/-lname '\*packages\/seeds\*'/);
    expect(pruned).toMatch(/-lname '\*@fluvia\/seeds\*'/);
    // reescritura del package.json SOLO del snapshot (los tres scripts)
    expect(pruned).toContain(`'seed'`);
    expect(pruned).toContain(`'showroom:seed'`);
    expect(pruned).toContain(`'demo:reset'`);
    expect(pruned).toContain('delete pkg.scripts[');
    // autocomprobacion: el build FALLA si queda cualquier resto de seeds
    expect(pruned).toMatch(/find \/app.+(packages\/seeds|@fluvia\/seeds)/);
  });

  it('la etapa final parte de base y su UNICA copia de /app procede del snapshot podado', () => {
    const runtime = stage('runtime');
    expect(runtime).toContain('FROM base AS runtime');
    expect(runtime).toContain('COPY --from=runtime-pruned /app /app');
    // PROHIBIDO el patron inseguro: copiar desde build o borrar tras el COPY.
    expect(runtime).not.toContain('COPY --from=build');
    expect(runtime).not.toMatch(/\bRUN\b[\s\S]*rm -rf/);
    expect(runtime).not.toContain('packages/seeds');
  });

  it('el pruning ocurre ANTES de la copia final (orden de etapas)', () => {
    const text = dockerfile();
    const prunedAt = text.indexOf('FROM build AS runtime-pruned');
    const finalAt = text.indexOf('FROM base AS runtime');
    const copyAt = text.indexOf('COPY --from=runtime-pruned /app /app');
    expect(prunedAt).toBeGreaterThan(-1);
    expect(finalAt).toBeGreaterThan(prunedAt);
    expect(copyAt).toBeGreaterThan(finalAt);
  });

  it('CMD y USER intactos; el package.json del REPO conserva los scripts locales', () => {
    const text = dockerfile();
    expect(text).toContain('CMD ["pnpm", "--filter", "@fluvia/api", "start"]');
    expect(text).toContain('USER node');
    const repoPkg = JSON.parse(
      readFileSync(join(dirname(DOCKERFILE_PATH), 'package.json'), 'utf8')
    ) as { scripts: Record<string, string> };
    expect(repoPkg.scripts.seed).toBeDefined();
    expect(repoPkg.scripts['showroom:seed']).toBeDefined();
    expect(repoPkg.scripts['demo:reset']).toBeDefined();
    expect(repoPkg.scripts['runtime:image:verify']).toBeDefined();
  });

  it('la CA de build es OPCIONAL y EFIMERA: secret mount, jamas ENV/COPY persistente', () => {
    const text = dockerfile();
    // soporte opcional via BuildKit secret en los RUN que necesitan red
    expect(text).toContain('--mount=type=secret,id=fluvia_build_ca,required=false');
    // ...pero JAMAS persistida: sin ENV global, sin COPY de una CA a una capa.
    expect(text).not.toMatch(/^ENV .*NODE_EXTRA_CA_CERTS/m);
    expect(text).not.toMatch(/^COPY .*\.(crt|pem)/m);
  });
});
