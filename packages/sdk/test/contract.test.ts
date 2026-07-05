import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SDK_ROUTES } from '../src/index.js';

/**
 * El SDK cubre EXACTAMENTE el plano de API key publicado en el contrato OpenAPI.
 * Si alguien añade una ruta al contrato sin método en el SDK (o al revés), este
 * test revienta — el SDK no puede quedar desincronizado del contrato.
 */

const SPEC_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'docs',
  'api',
  'openapi.v1.json'
);

interface Spec {
  paths: Record<string, Record<string, unknown>>;
}

function key(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

describe('SDK ↔ contrato OpenAPI', () => {
  const spec = JSON.parse(readFileSync(SPEC_PATH, 'utf8')) as Spec;
  const specRoutes = new Set(
    Object.entries(spec.paths).flatMap(([path, methods]) =>
      Object.keys(methods).map((m) => key(m, path))
    )
  );
  const sdkRoutes = new Set(SDK_ROUTES.map((r) => key(r.method, r.path)));

  it('covers exactly the published API-key surface (no drift either way)', () => {
    const missingInSdk = [...specRoutes].filter((r) => !sdkRoutes.has(r)).sort();
    const missingInSpec = [...sdkRoutes].filter((r) => !specRoutes.has(r)).sort();
    expect({ missingInSdk, missingInSpec }).toEqual({ missingInSdk: [], missingInSpec: [] });
  });

  it('declares no duplicate routes', () => {
    expect(sdkRoutes.size).toBe(SDK_ROUTES.length);
  });
});
