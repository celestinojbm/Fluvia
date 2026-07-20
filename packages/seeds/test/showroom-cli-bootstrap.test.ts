import { describe, expect, it } from 'vitest';
import type { loadConfig } from '@fluvia/config';
import { runShowroomResetCli } from '../src/run-reset.js';
import { runShowroomSeedCli } from '../src/run-showroom.js';
import {
  showroomUrlsFromEnv,
  type openVerifiedShowroomTarget,
  type runShowroomReset,
} from '../src/reset.js';
import { ShowroomDatabaseMismatchError, type seedShowroom } from '../src/showroom.js';

/**
 * RA-F65C3-EXT-006 (delta) — el BOOTSTRAP COMPLETO de los dos CLIs corre
 * dentro de la frontera sanitizada: loadConfig, env/argv, urlsFromEnv, guard,
 * pools, attestation, seed/reset, impresion y cleanup. Cualquier fallo (aun
 * ANTES del primer paso de negocio, u HOSTIL: getters que lanzan, Proxy,
 * ciclos, primitivas) produce exit code != 0 y UNA sola linea segura por
 * stderr, sin message/stack/cause/config crudos. El exito imprime las
 * credenciales sandbox UNA sola vez y SOLO al final.
 */

const SECRETS = {
  dbUrl: 'postgres://fluvia_app:sup3r-s3cret-pw@10.9.8.7:5432/fluvia',
  password: 'sup3r-s3cret-pw',
  token: 'fluvia_sk_live_9f8e7d6c5b4a3210',
  envSecret: 'env-var-secret-material-000',
} as const;

const GENERIC = /fallo inesperado \[unexpected_error\]/;

function collector() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    log: (line: string) => {
      out.push(line);
    },
    error: (line: string) => {
      err.push(line);
    },
  };
}

function expectSingleSafeLine(err: string[], cli: string): void {
  // UNA sola linea por stderr, del CLI correcto, sin material sensible.
  expect(err).toHaveLength(1);
  const line = err[0] ?? '';
  expect(line.startsWith(cli)).toBe(true);
  expect(line).not.toContain('\n');
  for (const secret of Object.values(SECRETS)) {
    expect(line.includes(secret)).toBe(false);
  }
  expect(line).not.toMatch(/postgres:\/\/|at \w+ \(|password/i);
}

const fakeConfig = (() => ({ env: 'test' })) as unknown as typeof loadConfig;
const localUrls = () => showroomUrlsFromEnv({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);

const fakeSeedResult = {
  organizationId: 'org-1',
  merchantId: 'mer-1',
  sandbox: {
    users: [
      { email: 'owner@fluvia.dev', password: 'showroom-owner-sandbox', role: 'owner' as const },
      {
        email: 'reviewer@fluvia.dev',
        password: 'showroom-reviewer-sandbox',
        role: 'reviewer' as const,
      },
    ],
    apiKey: {
      label: 'Showroom sandbox key',
      keyPrefix: 'fluvia_sk_test_',
      secret: 'sandbox-api-key-material',
      environment: 'test' as const,
    },
  },
};

describe('runShowroomSeedCli: frontera sanitizada COMPLETA', () => {
  it('loadConfig lanza con un secreto de env: exit 1 + UNA linea generica', async () => {
    const c = collector();
    const code = await runShowroomSeedCli({
      loadConfig: (() => {
        throw new Error(`config parse failed: DATABASE_URL=${SECRETS.dbUrl}`);
      }) as unknown as typeof loadConfig,
      log: c.log,
      error: c.error,
    });
    expect(code).toBe(1);
    expectSingleSafeLine(c.err, 'showroom:seed');
    expect(c.err[0]).toMatch(GENERIC);
    expect(c.err[0]).toContain('en fase startup');
    expect(c.out).toHaveLength(0); // nada impreso antes del fallo
  });

  it('urlsFromEnv lanza con la URL completa: exit 1 + UNA linea generica', async () => {
    const c = collector();
    const code = await runShowroomSeedCli({
      loadConfig: fakeConfig,
      urlsFromEnv: () => {
        throw new Error(`invalid SHOWROOM_APP_DATABASE_URL: ${SECRETS.dbUrl}`);
      },
      log: c.log,
      error: c.error,
    });
    expect(code).toBe(1);
    expectSingleSafeLine(c.err, 'showroom:seed');
    expect(c.err[0]).toMatch(GENERIC);
  });

  it('mismatch de attestation (detail con connectionString): plantilla FIJA sin la URL', async () => {
    const c = collector();
    const code = await runShowroomSeedCli({
      loadConfig: fakeConfig,
      urlsFromEnv: localUrls,
      openTarget: (async () => {
        throw new ShowroomDatabaseMismatchError(`live db behind ${SECRETS.dbUrl}`);
      }) as unknown as typeof openVerifiedShowroomTarget,
      log: c.log,
      error: c.error,
    });
    expect(code).toBe(1);
    expectSingleSafeLine(c.err, 'showroom:seed');
    expect(c.err[0]).toContain('[target_database_mismatch]');
  });

  it('cause anidada secreta en un unknown: jamas impresa', async () => {
    const c = collector();
    const code = await runShowroomSeedCli({
      loadConfig: fakeConfig,
      urlsFromEnv: localUrls,
      openTarget: (async () => {
        throw new Error('outer boom', {
          cause: Object.assign(new Error(`inner: ${SECRETS.token}`), { config: SECRETS.dbUrl }),
        });
      }) as unknown as typeof openVerifiedShowroomTarget,
      log: c.log,
      error: c.error,
    });
    expect(code).toBe(1);
    expectSingleSafeLine(c.err, 'showroom:seed');
    expect(c.err[0]).toMatch(GENERIC);
  });

  it('objeto hostil con getters que lanzan: exit 1, una linea, sin crash', async () => {
    const hostile = Object.create(Error.prototype) as object;
    for (const key of ['message', 'code', 'name', 'stack', 'cause']) {
      Object.defineProperty(hostile, key, {
        get() {
          throw new Error(`hostile ${key}: ${SECRETS.password}`);
        },
      });
    }
    const c = collector();
    const code = await runShowroomSeedCli({
      loadConfig: fakeConfig,
      urlsFromEnv: localUrls,
      openTarget: (async () => {
        throw hostile;
      }) as unknown as typeof openVerifiedShowroomTarget,
      log: c.log,
      error: c.error,
    });
    expect(code).toBe(1);
    expectSingleSafeLine(c.err, 'showroom:seed');
    expect(c.err[0]).toMatch(GENERIC);
  });

  it('string token lanzado como excepcion: no se refleja', async () => {
    const c = collector();
    const code = await runShowroomSeedCli({
      loadConfig: fakeConfig,
      urlsFromEnv: localUrls,
      openTarget: (async () => {
        throw SECRETS.token;
      }) as unknown as typeof openVerifiedShowroomTarget,
      log: c.log,
      error: c.error,
    });
    expect(code).toBe(1);
    expectSingleSafeLine(c.err, 'showroom:seed');
  });

  it('stack con rutas y URL jamas aparece en stderr', async () => {
    const boom = new Error('seed exploded');
    boom.stack = `Error: seed exploded ${SECRETS.dbUrl}\n    at seedShowroom (/app/secret/showroom.ts:9:9)`;
    const c = collector();
    const code = await runShowroomSeedCli({
      loadConfig: fakeConfig,
      urlsFromEnv: localUrls,
      openTarget: (async () => ({
        target: { kind: 'verified-showroom-target' },
        targetDbName: 'fluvia_showroom',
        close: async () => undefined,
      })) as unknown as typeof openVerifiedShowroomTarget,
      seed: (async () => {
        throw boom;
      }) as unknown as typeof seedShowroom,
      log: c.log,
      error: c.error,
    });
    expect(code).toBe(1);
    expectSingleSafeLine(c.err, 'showroom:seed');
    expect(c.err[0]).not.toContain('at seedShowroom');
  });

  it('fallo del seed + fallo del close(): el close degradado NO añade secretos', async () => {
    const c = collector();
    const code = await runShowroomSeedCli({
      loadConfig: fakeConfig,
      urlsFromEnv: localUrls,
      openTarget: (async () => ({
        target: { kind: 'verified-showroom-target' },
        targetDbName: 'fluvia_showroom',
        close: async () => {
          throw new Error(`close failed: ${SECRETS.dbUrl}`);
        },
      })) as unknown as typeof openVerifiedShowroomTarget,
      seed: (async () => {
        throw new Error('seed failed');
      }) as unknown as typeof seedShowroom,
      log: c.log,
      error: c.error,
    });
    expect(code).toBe(1);
    // Dos lineas: la del error y el warning FIJO del cleanup — ambas seguras.
    expect(c.err).toHaveLength(2);
    expect(c.err[0]).toMatch(GENERIC);
    expect(c.err[1]).toBe('showroom:seed cleanup warning [pool_close_failed]');
    for (const line of c.err) {
      expect(line.includes(SECRETS.dbUrl)).toBe(false);
    }
  });

  it('exito: credenciales sandbox impresas UNA sola vez y SOLO al final', async () => {
    const c = collector();
    let closed = 0;
    const code = await runShowroomSeedCli({
      loadConfig: fakeConfig,
      urlsFromEnv: localUrls,
      openTarget: (async () => ({
        target: { kind: 'verified-showroom-target' },
        targetDbName: 'fluvia_showroom',
        close: async () => {
          closed += 1;
        },
      })) as unknown as typeof openVerifiedShowroomTarget,
      seed: (async () => fakeSeedResult) as unknown as typeof seedShowroom,
      log: c.log,
      error: c.error,
    });
    expect(code).toBe(0);
    expect(c.err).toHaveLength(0);
    expect(closed).toBe(1);
    const all = c.out.join('\n');
    const occurrences = all.split('sandbox-api-key-material').length - 1;
    expect(occurrences).toBe(1);
    // Las credenciales van en la ULTIMA linea impresa (tras el exito).
    expect(c.out[c.out.length - 1]).toContain('CREDENCIALES SANDBOX');
    expect(c.out[c.out.length - 1]).toContain('owner@fluvia.dev');
  });
});

describe('runShowroomResetCli: frontera sanitizada COMPLETA', () => {
  it('--help: exit 0 sin tocar config/urls/reset', async () => {
    const c = collector();
    const code = await runShowroomResetCli({
      argv: ['--help'],
      loadConfig: (() => {
        throw new Error('must not be called');
      }) as unknown as typeof loadConfig,
      log: c.log,
      error: c.error,
    });
    expect(code).toBe(0);
    expect(c.err).toHaveLength(0);
    expect(c.out.join('\n')).toContain('RESET_FLUVIA_SHOWROOM');
  });

  it('loadConfig lanza: exit 1 + UNA linea generica en fase startup', async () => {
    const c = collector();
    const code = await runShowroomResetCli({
      argv: ['--confirm', 'RESET_FLUVIA_SHOWROOM'],
      loadConfig: (() => {
        throw new Error(`dotenv blew up: ${SECRETS.envSecret}`);
      }) as unknown as typeof loadConfig,
      log: c.log,
      error: c.error,
    });
    expect(code).toBe(1);
    expectSingleSafeLine(c.err, 'demo:reset');
    expect(c.err[0]).toContain('en fase startup');
    expect(c.out).toHaveLength(0);
  });

  it('sin --confirm: guard con plantilla FIJA accionable, exit 1, nada anunciado', async () => {
    const c = collector();
    const code = await runShowroomResetCli({
      argv: [],
      loadConfig: fakeConfig,
      urlsFromEnv: localUrls,
      log: c.log,
      error: c.error,
    });
    expect(code).toBe(1);
    expectSingleSafeLine(c.err, 'demo:reset');
    expect(c.err[0]).toBe(
      'demo:reset blocked: pass --confirm RESET_FLUVIA_SHOWROOM to authorize the destructive reset [confirmation_mismatch]'
    );
    expect(c.out).toHaveLength(0); // el target jamas se anuncia sin confirmacion
  });

  it('Proxy hostil lanzado por el reset: degradacion total sin crash', async () => {
    const proxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error(`hostile proto: ${SECRETS.password}`);
        },
        get() {
          throw new Error(`hostile get: ${SECRETS.token}`);
        },
      }
    );
    const c = collector();
    const code = await runShowroomResetCli({
      argv: ['--confirm', 'RESET_FLUVIA_SHOWROOM'],
      loadConfig: fakeConfig,
      urlsFromEnv: localUrls,
      runReset: (async () => {
        throw proxy;
      }) as unknown as typeof runShowroomReset,
      log: c.log,
      error: c.error,
    });
    expect(code).toBe(1);
    expectSingleSafeLine(c.err, 'demo:reset');
    expect(c.err[0]).toMatch(GENERIC);
  });

  it('error circular lanzado por el reset: sin recursion ni volcado', async () => {
    interface Circular {
      message: string;
      cause?: Circular;
    }
    const circular: Circular = { message: `loop ${SECRETS.dbUrl}` };
    circular.cause = circular;
    const c = collector();
    const code = await runShowroomResetCli({
      argv: ['--confirm', 'RESET_FLUVIA_SHOWROOM'],
      loadConfig: fakeConfig,
      urlsFromEnv: localUrls,
      runReset: (async () => {
        throw circular;
      }) as unknown as typeof runShowroomReset,
      log: c.log,
      error: c.error,
    });
    expect(code).toBe(1);
    expectSingleSafeLine(c.err, 'demo:reset');
  });

  it('exito: credenciales sandbox UNA sola vez al final, exit 0', async () => {
    const c = collector();
    const code = await runShowroomResetCli({
      argv: ['--confirm', 'RESET_FLUVIA_SHOWROOM'],
      loadConfig: fakeConfig,
      urlsFromEnv: localUrls,
      runReset: (async () => ({
        targetDbName: 'fluvia_showroom',
        seed: fakeSeedResult,
        manifest: { manifestVersion: 1 },
        invariants: 'passed',
      })) as unknown as typeof runShowroomReset,
      log: c.log,
      error: c.error,
    });
    expect(code).toBe(0);
    expect(c.err).toHaveLength(0);
    const all = c.out.join('\n');
    expect(all.split('sandbox-api-key-material').length - 1).toBe(1);
    expect(c.out[c.out.length - 1]).toContain('CREDENCIALES SANDBOX');
  });
});
