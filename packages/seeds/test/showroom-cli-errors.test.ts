import { describe, expect, it } from 'vitest';
import { formatSafeShowroomCliError } from '../src/cli-errors.js';
import { ShowroomUnverifiedTargetError } from '../src/live-identity.js';
import {
  ShowroomResetGuardError,
  ShowroomSeedGuardError,
  ShowroomTargetRemovedError,
} from '../src/reset.js';
import { ShowroomAlreadySeededError, ShowroomDatabaseMismatchError } from '../src/showroom.js';

/**
 * RA-F65C3-EXT-006 — el formatter COMPARTIDO de errores de los dos CLIs jamas
 * imprime material sensible de un error DESCONOCIDO: ni objeto, ni stack, ni
 * cause, ni message crudo, ni config/URL/connectionString/userinfo/query/
 * password/token/secreto. Cada secreto de los escenarios se afirma AUSENTE
 * byte-for-byte de la salida. Los errores CONOCIDOS conservan su mensaje
 * estable (controlado por nosotros) y su cause interna NUNCA se imprime.
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

describe('formatSafeShowroomCliError: errores desconocidos SANITIZADOS', () => {
  it('Error con URL postgres://user:password@ en el message no la filtra', () => {
    const err = new Error(`connect failed for ${SECRETS.dbUrl}`);
    const out = formatSafeShowroomCliError('showroom:seed', err, 'preflight');
    expect(out).toBe('showroom:seed fallo inesperado [unexpected_error] en fase preflight (Error)');
    expectNoSecretBytes(out);
  });

  it('error de driver con query con password y campos de config no los filtra', () => {
    const err = Object.assign(new Error(SECRETS.queryPassword), {
      query: SECRETS.queryPassword,
      connectionString: SECRETS.dbUrl,
      config: { connectionString: SECRETS.dbUrl, password: SECRETS.password },
      code: '28P01',
    });
    const out = formatSafeShowroomCliError('demo:reset', err, 'drop-create');
    expect(out).toBe(
      'demo:reset fallo inesperado [unexpected_error] en fase drop-create (Error, code 28P01)'
    );
    expectNoSecretBytes(out);
  });

  it('cause anidada con secretos (cadena) no se imprime jamas', () => {
    const inner = Object.assign(new Error(`auth failed: ${SECRETS.token}`), {
      code: SECRETS.apiKeySecret, // un code con forma de secreto NO pasa la allowlist
    });
    const err = new Error(`wrapper: ${SECRETS.webhookSecret}`, { cause: inner });
    const out = formatSafeShowroomCliError('showroom:seed', err, 'api-key');
    expect(out).toBe('showroom:seed fallo inesperado [unexpected_error] en fase api-key (Error)');
    expectNoSecretBytes(out);
  });

  it('objeto tipo pg con connectionString y error de fetch con URL no filtran nada', () => {
    const pgLike = {
      connectionString: SECRETS.dbUrl,
      message: `pool error for ${SECRETS.dbUrl}`,
    };
    const outPg = formatSafeShowroomCliError('demo:reset', pgLike, 'migrate');
    expect(outPg).toBe('demo:reset fallo inesperado [unexpected_error] en fase migrate (Object)');
    expectNoSecretBytes(outPg);

    const fetchErr = Object.assign(new TypeError(`fetch failed: ${SECRETS.fetchUrl}`), {
      code: 'ECONNREFUSED',
      url: SECRETS.fetchUrl,
    });
    const outFetch = formatSafeShowroomCliError('showroom:seed', fetchErr, 'deliver');
    expect(outFetch).toBe(
      'showroom:seed fallo inesperado [unexpected_error] en fase deliver (TypeError, code ECONNREFUSED)'
    );
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
    expect(out).toBe(
      'showroom:seed fallo inesperado [unexpected_error] en fase desconocida (Error)'
    );
    expect(out).not.toContain('at seedShowroom');
    expectNoSecretBytes(out);
  });

  it('primitivas y null no revientan ni filtran', () => {
    expect(formatSafeShowroomCliError('demo:reset', SECRETS.token, 'seed')).toBe(
      'demo:reset fallo inesperado [unexpected_error] en fase seed'
    );
    expect(formatSafeShowroomCliError('demo:reset', null, 'seed')).toBe(
      'demo:reset fallo inesperado [unexpected_error] en fase seed'
    );
  });
});

describe('formatSafeShowroomCliError: errores conocidos con mensaje estable', () => {
  it('guards y errores tipados del showroom conservan su mensaje controlado', () => {
    const guard = new ShowroomResetGuardError('target_denylisted', 'target[app] is denylisted');
    expect(formatSafeShowroomCliError('demo:reset', guard, 'guard')).toBe(
      `demo:reset fallo: ${guard.message}`
    );
    const seedGuard = new ShowroomSeedGuardError('env_not_allowed', 'env "production"');
    expect(formatSafeShowroomCliError('showroom:seed', seedGuard, 'startup')).toBe(
      `showroom:seed fallo: ${seedGuard.message}`
    );
    const seeded = new ShowroomAlreadySeededError('organization exists');
    expect(formatSafeShowroomCliError('showroom:seed', seeded, 'preflight')).toContain(
      'demo:reset'
    );
    const mismatch = new ShowroomDatabaseMismatchError('live current_database() is "fluvia"');
    expect(formatSafeShowroomCliError('showroom:seed', mismatch, 'preflight')).toBe(
      `showroom:seed fallo: ${mismatch.message}`
    );
    const unverified = new ShowroomUnverifiedTargetError();
    expect(formatSafeShowroomCliError('showroom:seed', unverified, 'preflight')).toBe(
      `showroom:seed fallo: ${unverified.message}`
    );
  });

  it('ShowroomTargetRemovedError: mensaje estable impreso, cause interna JAMAS', () => {
    const cause = new Error(`CREATE DATABASE failed: ${SECRETS.dbUrl}`);
    const err = new ShowroomTargetRemovedError('fluvia_showroom_test_x1', cause);
    const out = formatSafeShowroomCliError('demo:reset', err, 'drop-create');
    expect(out).toBe(`demo:reset fallo: ${err.message}`);
    expect(err.code).toBe('target_removed_rebuild_required');
    expect(out).toContain('run demo:reset again');
    expect(out).not.toContain('CREATE DATABASE failed');
    expectNoSecretBytes(out);
  });
});
