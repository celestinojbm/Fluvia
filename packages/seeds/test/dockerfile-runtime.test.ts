import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * F6.5C3 (revision pre-auditoria) — regresion ESTATICA: la etapa `runtime` del
 * Dockerfile debe seguir EXCLUYENDO el tooling de seeds del filesystem de la
 * imagen app (plan F6.5C §6: `demo:reset` jamas viaja en la imagen del profile
 * app). Este test falla si alguien elimina la exclusion en el futuro.
 *
 * NO sustituye al build real: la evidencia definitiva es
 * `docker build --target runtime` + inspeccion del filesystem (reportada en el
 * PR); esto solo impide una regresion silenciosa del Dockerfile.
 */

const DOCKERFILE_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../../Dockerfile');

function runtimeStage(): string {
  const dockerfile = readFileSync(DOCKERFILE_PATH, 'utf8');
  const start = dockerfile.indexOf('FROM base AS runtime');
  expect(start).toBeGreaterThan(-1);
  return dockerfile.slice(start);
}

describe('Dockerfile: la etapa runtime excluye el tooling del showroom', () => {
  it('elimina /app/packages/seeds del filesystem runtime, tras el COPY y antes de USER/CMD', () => {
    const stage = runtimeStage();
    const copyAt = stage.indexOf('COPY --from=build /app /app');
    const rmAt = stage.indexOf('rm -rf /app/packages/seeds');
    const userAt = stage.indexOf('USER node');
    expect(copyAt).toBeGreaterThan(-1);
    expect(rmAt).toBeGreaterThan(copyAt);
    expect(userAt).toBeGreaterThan(rmAt); // el borrado corre como root, antes de degradar
  });

  it('quita los scripts seed/showroom:seed/demo:reset SOLO del package.json de la capa runtime', () => {
    const stage = runtimeStage();
    // La reescritura enumera exactamente los tres scripts locales del tooling.
    expect(stage).toContain(`'seed'`);
    expect(stage).toContain(`'showroom:seed'`);
    expect(stage).toContain(`'demo:reset'`);
    expect(stage).toContain('delete pkg.scripts[');
    // …y el package.json del REPO (desarrollo local) conserva los tres.
    const repoPkg = JSON.parse(
      readFileSync(join(dirname(DOCKERFILE_PATH), 'package.json'), 'utf8')
    ) as { scripts: Record<string, string> };
    expect(repoPkg.scripts.seed).toBeDefined();
    expect(repoPkg.scripts['showroom:seed']).toBeDefined();
    expect(repoPkg.scripts['demo:reset']).toBeDefined();
  });

  it('la exclusion no toca el build stage ni el CMD del API', () => {
    const dockerfile = readFileSync(DOCKERFILE_PATH, 'utf8');
    const buildStage = dockerfile.slice(
      dockerfile.indexOf('FROM base AS build'),
      dockerfile.indexOf('FROM base AS runtime')
    );
    expect(buildStage).not.toContain('rm -rf'); // el build valida el monorepo completo
    expect(dockerfile).toContain('CMD ["pnpm", "--filter", "@fluvia/api", "start"]');
    expect(dockerfile).toContain('USER node');
  });
});
