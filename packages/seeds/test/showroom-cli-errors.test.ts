import { describe, expect, it } from 'vitest';
import { formatSafeShowroomCliError } from '../src/cli-errors.js';
import { ShowroomUnverifiedTargetError } from '../src/live-identity.js';
import {
  ShowroomResetGuardError,
  ShowroomResetSequenceError,
  ShowroomSeedGuardError,
  ShowroomTargetRemovedError,
} from '../src/reset.js';
import {
  ShowroomAlreadySeededError,
  ShowroomDatabaseMismatchError,
  ShowroomEnvironmentError,
  ShowroomSeedError,
} from '../src/showroom.js';

/**
 * RA-F65C3-EXT-006 (delta) — el formatter COMPARTIDO de los dos CLIs imprime
 * PLANTILLAS FIJAS: los errores CONOCIDOS jamas reflejan `error.message` (sus
 * clases aceptan `detail` externo que puede transportar URLs/SQL/secretos) y
 * los DESCONOCIDOS producen una unica linea generica SIN acceder a NINGUNA
 * propiedad del objeto (getters hostiles, Proxies y ciclos no pueden romper
 * ni contaminar la salida). Cada secreto de los escenarios se afirma AUSENTE
 * byte-for-byte.
 */

const SECRETS = {
  dbUrl: 'postgres://fluvia_app:sup3r-s3cret-pw@10.9.8.7:5432/fluvia',
  password: 'sup3r-s3cret-pw',
  queryPassword: "ALTER ROLE fluvia_app PASSWORD 'hunter2-rotated'",
  token: 'fluvia_sk_live_9f8e7d6c5b4a3210',
  apiKeySecret: 'fluvia_sk_test_deadbeefcafebabe',
  // Fixture SINTETICO de baja entropia (sin prefijo de proveedor): prueba la
  // ausencia de REFLEXION del valor recibido, no la forma de un secreto real
  // (un fixture con forma realista dispara el gate de secret scanning).
  webhookSecret: 'fixturefixturefixturefixture',
  showroomPassword: 'showroom-owner-sandbox',
  fetchUrl: 'https://internal.example.test/hook?sig=abc123&key=topsecret',
} as const;

function expectNoSecretBytes(output: string): void {
  for (const [label, secret] of Object.entries(SECRETS)) {
    expect(output.includes(secret), `output must not contain ${label}`).toBe(false);
  }
}

describe('formatSafeShowroomCliError: errores desconocidos, linea generica SIN propiedades', () => {
  it('Error con URL postgres://user:password@ en el message: ni URL, ni className, ni message', () => {
    const err = new Error(`connect failed for ${SECRETS.dbUrl}`);
    const out = formatSafeShowroomCliError('showroom:seed', err, 'preflight');
    expect(out).toBe('showroom:seed fallo inesperado [unexpected_error] en fase preflight');
    expectNoSecretBytes(out);
  });

  it('error de driver con query/config/code: el code YA NO se refleja (cero propiedades)', () => {
    const err = Object.assign(new Error(SECRETS.queryPassword), {
      query: SECRETS.queryPassword,
      connectionString: SECRETS.dbUrl,
      config: { connectionString: SECRETS.dbUrl, password: SECRETS.password },
      code: '28P01',
    });
    const out = formatSafeShowroomCliError('demo:reset', err, 'drop-create');
    expect(out).toBe('demo:reset fallo inesperado [unexpected_error] en fase drop-create');
    expect(out).not.toContain('28P01');
    expectNoSecretBytes(out);
  });

  it('cause anidada con secretos (cadena) no se imprime jamas', () => {
    const inner = Object.assign(new Error(`auth failed: ${SECRETS.token}`), {
      code: SECRETS.apiKeySecret,
    });
    const err = new Error(`wrapper: ${SECRETS.webhookSecret}`, { cause: inner });
    const out = formatSafeShowroomCliError('showroom:seed', err, 'api-key');
    expect(out).toBe('showroom:seed fallo inesperado [unexpected_error] en fase api-key');
    expectNoSecretBytes(out);
  });

  it('objeto tipo pg con connectionString y error de fetch con URL no filtran nada', () => {
    const pgLike = {
      connectionString: SECRETS.dbUrl,
      message: `pool error for ${SECRETS.dbUrl}`,
    };
    const outPg = formatSafeShowroomCliError('demo:reset', pgLike, 'migrate');
    expect(outPg).toBe('demo:reset fallo inesperado [unexpected_error] en fase migrate');
    expectNoSecretBytes(outPg);

    const fetchErr = Object.assign(new TypeError(`fetch failed: ${SECRETS.fetchUrl}`), {
      code: 'ECONNREFUSED',
      url: SECRETS.fetchUrl,
    });
    const outFetch = formatSafeShowroomCliError('showroom:seed', fetchErr, 'deliver');
    expect(outFetch).toBe('showroom:seed fallo inesperado [unexpected_error] en fase deliver');
    expect(outFetch).not.toContain('ECONNREFUSED');
    expect(outFetch).not.toContain('TypeError');
    expectNoSecretBytes(outFetch);
  });

  it('password del showroom y stack jamas aparecen; fase no allowlisted se degrada', () => {
    const err = new Error(`login ${SECRETS.showroomPassword} rejected`);
    err.stack = `Error: at ${SECRETS.dbUrl}\n    at seedShowroom (/app/secret/path.ts:1:1)`;
    const out = formatSafeShowroomCliError(
      'showroom:seed',
      err,
      `fase con ${SECRETS.password} embebido` // una "fase" hostil no se refleja
    );
    expect(out).toBe('showroom:seed fallo inesperado [unexpected_error] en fase desconocida');
    expect(out).not.toContain('at seedShowroom');
    expectNoSecretBytes(out);
  });

  it('primitivas y null no revientan ni filtran (un string con token no se refleja)', () => {
    const outToken = formatSafeShowroomCliError('demo:reset', SECRETS.token, 'seed');
    expect(outToken).toBe('demo:reset fallo inesperado [unexpected_error] en fase seed');
    expectNoSecretBytes(outToken);
    expect(formatSafeShowroomCliError('demo:reset', null, 'seed')).toBe(
      'demo:reset fallo inesperado [unexpected_error] en fase seed'
    );
    expect(formatSafeShowroomCliError('demo:reset', undefined, 'seed')).toBe(
      'demo:reset fallo inesperado [unexpected_error] en fase seed'
    );
  });
});

describe('formatSafeShowroomCliError: objetos HOSTILES (getters/Proxy/ciclos)', () => {
  it('getters que lanzan en message/code/name/stack: linea generica, jamas revienta', () => {
    const hostile = Object.create(Error.prototype) as object;
    for (const key of ['message', 'code', 'name', 'stack', 'cause', 'constructor']) {
      Object.defineProperty(hostile, key, {
        get() {
          throw new Error(`boom via getter ${key}: ${SECRETS.dbUrl}`);
        },
        configurable: true,
      });
    }
    const out = formatSafeShowroomCliError('showroom:seed', hostile, 'preflight');
    expect(out).toBe('showroom:seed fallo inesperado [unexpected_error] en fase preflight');
    expectNoSecretBytes(out);
  });

  it('Proxy que lanza en getPrototypeOf (rompe instanceof): degradacion total', () => {
    const proxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error(`hostile getPrototypeOf: ${SECRETS.token}`);
        },
        get() {
          throw new Error(`hostile get: ${SECRETS.password}`);
        },
      }
    );
    const out = formatSafeShowroomCliError('demo:reset', proxy, 'guard');
    expect(out).toBe('demo:reset fallo inesperado [unexpected_error] en fase desconocida');
    expectNoSecretBytes(out);
  });

  it('objeto circular con secretos: sin recursion, sin volcado', () => {
    interface Circular {
      message: string;
      self?: Circular;
      cause?: Circular;
    }
    const circular: Circular = { message: `circular ${SECRETS.webhookSecret}` };
    circular.self = circular;
    circular.cause = circular;
    const out = formatSafeShowroomCliError('showroom:seed', circular, 'seed');
    expect(out).toBe('showroom:seed fallo inesperado [unexpected_error] en fase seed');
    expectNoSecretBytes(out);
  });

  it('guard falsificado con code hostil (getter) no pasa la allowlist', () => {
    const forged = new ShowroomResetGuardError('target_denylisted', 'x');
    Object.defineProperty(forged, 'code', {
      get() {
        throw new Error(`hostile code getter: ${SECRETS.dbUrl}`);
      },
      configurable: true,
    });
    const out = formatSafeShowroomCliError('demo:reset', forged, 'guard');
    expect(out).toBe('demo:reset fallo inesperado [unexpected_error] en fase guard');
    expectNoSecretBytes(out);
  });
});

describe('formatSafeShowroomCliError: errores conocidos con PLANTILLA FIJA (jamas message)', () => {
  it('guard de reset: plantilla por code; el detail (con password) JAMAS se refleja', () => {
    const guard = new ShowroomResetGuardError(
      'target_denylisted',
      `target[app] is denylisted (${SECRETS.dbUrl})`
    );
    const out = formatSafeShowroomCliError('demo:reset', guard, 'guard');
    expect(out).toBe('demo:reset blocked by target guard [target_denylisted]');
    expect(out).not.toContain('target[app]');
    expectNoSecretBytes(out);
  });

  it('confirmation_mismatch: plantilla accionable fija', () => {
    const guard = new ShowroomResetGuardError('confirmation_mismatch', 'got "--confirm yes"');
    const out = formatSafeShowroomCliError('demo:reset', guard, 'guard');
    expect(out).toBe(
      'demo:reset blocked: pass --confirm RESET_FLUVIA_SHOWROOM to authorize the destructive reset [confirmation_mismatch]'
    );
    expect(out).not.toContain('got "');
  });

  it('guard de seed: plantilla por code; detail con URL jamas impreso', () => {
    const guard = new ShowroomSeedGuardError('host_not_loopback', `host is ${SECRETS.dbUrl}`);
    const out = formatSafeShowroomCliError('showroom:seed', guard, 'startup');
    expect(out).toBe('showroom:seed blocked by target guard [host_not_loopback]');
    expectNoSecretBytes(out);
  });

  it('ShowroomEnvironmentError: plantilla fija sin el env recibido', () => {
    const err = new ShowroomEnvironmentError(`production ${SECRETS.password}`);
    const out = formatSafeShowroomCliError('showroom:seed', err, 'startup');
    expect(out).toBe(
      'showroom:seed blocked: showroom tooling is local/test-only [env_not_allowed]'
    );
    expectNoSecretBytes(out);
  });

  it('ShowroomTargetRemovedError: plantilla fija, cause interna JAMAS', () => {
    const cause = new Error(`CREATE DATABASE failed: ${SECRETS.dbUrl}`);
    const err = new ShowroomTargetRemovedError('fluvia_showroom_test_x1', cause);
    const out = formatSafeShowroomCliError('demo:reset', err, 'drop-create');
    expect(out).toBe(
      'demo:reset: the dedicated showroom database was removed (DROP succeeded) but CREATE did not complete; migrate/seed/invariants never started — run demo:reset again to rebuild [target_removed_rebuild_required]'
    );
    expect(err.code).toBe('target_removed_rebuild_required');
    expect(out).not.toContain('CREATE DATABASE failed');
    expect(out).not.toContain('fluvia_showroom_test_x1');
    expectNoSecretBytes(out);
  });

  it('ShowroomResetSequenceError / AlreadySeeded / Mismatch / Unverified / SeedError: plantillas', () => {
    expect(
      formatSafeShowroomCliError('demo:reset', new ShowroomResetSequenceError('x'), 'drop-create')
    ).toBe(
      'demo:reset: reset sequence failed at a guarded maintenance step [reset_sequence_failed]'
    );

    const seeded = formatSafeShowroomCliError(
      'showroom:seed',
      new ShowroomAlreadySeededError(`marker ${SECRETS.dbUrl}`),
      'preflight'
    );
    expect(seeded).toBe(
      'showroom:seed: showroom data already exists; rebuild with: pnpm demo:reset -- --confirm RESET_FLUVIA_SHOWROOM [already_seeded]'
    );
    expectNoSecretBytes(seeded);

    const mismatch = formatSafeShowroomCliError(
      'showroom:seed',
      new ShowroomDatabaseMismatchError(`live db behind ${SECRETS.dbUrl}`),
      'preflight'
    );
    expect(mismatch).toBe(
      'showroom:seed: showroom target identity mismatch (live attestation rejected the databases behind the pools) [target_database_mismatch]'
    );
    expectNoSecretBytes(mismatch);

    expect(
      formatSafeShowroomCliError('showroom:seed', new ShowroomUnverifiedTargetError(), 'preflight')
    ).toBe(
      'showroom:seed: showroom target verification failed (seedShowroom only accepts a handle produced by verifyShowroomTarget) [target_not_verified]'
    );

    const seedErr = formatSafeShowroomCliError(
      'showroom:seed',
      new ShowroomSeedError(`row count ${SECRETS.token}`),
      'verify'
    );
    expect(seedErr).toBe(
      'showroom:seed: showroom seed postcondition failed; rebuild with demo:reset [seed_postcondition_failed]'
    );
    expectNoSecretBytes(seedErr);
  });
});
