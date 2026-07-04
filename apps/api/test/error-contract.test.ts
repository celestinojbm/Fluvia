import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { loadConfig } from '@fluvia/config';
import { createPool, type Pool } from '@fluvia/db';
import { buildApp } from '../src/app.js';
import {
  DOMAIN_ERROR_CODES,
  ERROR_CATALOG,
  ERROR_CATALOG_VERSION,
  ERROR_CATEGORIES,
  errorBody,
} from '../src/error-catalog.js';

/**
 * F1-08 — Tests de CONTRATO de la taxonomia de errores (AUD-P2-009).
 * El golden comprometido en git ES el contrato v1: cualquier cambio de
 * code/status/type existente rompe aqui y exige bump de version consciente.
 */

const GOLDEN_PATH = join(dirname(fileURLToPath(import.meta.url)), 'golden/error-catalog.v1.json');

let appPool: Pool;

beforeAll(() => {
  appPool = createPool({ connectionString: loadConfig({}).db.app, max: 2 });
});

afterAll(async () => {
  await appPool.end();
});

describe('catalogo versionado (golden = contrato publicado)', () => {
  const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as {
    version: number;
    catalog: typeof ERROR_CATALOG;
    domain_error_codes: typeof DOMAIN_ERROR_CODES;
  };

  it('the runtime catalog matches the committed v1 contract EXACTLY', () => {
    expect(ERROR_CATALOG_VERSION).toBe(golden.version);
    expect(ERROR_CATALOG).toEqual(golden.catalog);
    expect(DOMAIN_ERROR_CODES).toEqual(golden.domain_error_codes);
  });

  it('every entry is coherent: known category, status in range and matching family', () => {
    const familyByCategory: Record<string, (s: number) => boolean> = {
      validation_error: (s) => s === 400 || s === 413 || s === 415,
      authentication_error: (s) => s === 401,
      authorization_error: (s) => s === 403,
      not_found_error: (s) => s === 404,
      conflict_error: (s) => s === 409,
      locked_error: (s) => s === 423,
      rate_limit_error: (s) => s === 429,
      internal_error: (s) => s >= 500,
    };
    for (const [code, entry] of Object.entries(ERROR_CATALOG)) {
      expect(ERROR_CATEGORIES, `categoria desconocida en ${code}`).toContain(entry.type);
      expect(
        familyByCategory[entry.type]!(entry.status),
        `${code}: status ${entry.status} incoherente con ${entry.type}`
      ).toBe(true);
      expect(entry.message.length, `${code}: message vacio`).toBeGreaterThan(0);
      // Mensajes publicos: sin pistas de implementacion.
      expect(entry.message).not.toMatch(/postgres|sql|stack|fluvia_[a-z]+_dev/i);
    }
  });

  it('every domain error class maps to an existing catalog code', () => {
    for (const [errName, code] of Object.entries(DOMAIN_ERROR_CODES)) {
      expect(ERROR_CATALOG[code], `${errName} -> ${code} no existe en el catalogo`).toBeDefined();
    }
  });

  it('errorBody only attaches details where the catalog allows it', () => {
    const withDetails = errorBody('validation_error', 'req-1', [{ path: 'x', message: 'bad' }]);
    expect(withDetails.error.details).toBeDefined();
    const ignored = errorBody('email_taken', 'req-2', [{ leak: 'nope' }]);
    expect(ignored.error.details).toBeUndefined();
  });
});

describe('sobre estable en HTTP real (mensajes del catalogo, jamas err.message)', () => {
  it('a domain error responds with the PUBLIC catalog message, not the internal one', async () => {
    const app = buildApp({ config: loadConfig({}), appPool });
    // Ruta de prueba que lanza un error de dominio con detalle interno.
    app.get('/boom-domain', async () => {
      const err = new Error('internal detail: account 123e4567 has balance -500');
      err.name = 'InsufficientBalanceError';
      throw err;
    });
    const res = await app.inject({ method: 'GET', url: '/boom-domain' });
    expect(res.statusCode).toBe(409);
    const body = res.json() as {
      error: { type: string; code: string; message: string; request_id: string };
    };
    expect(body.error.code).toBe('insufficient_balance');
    expect(body.error.type).toBe('conflict_error');
    expect(body.error.message).toBe(ERROR_CATALOG.insufficient_balance.message);
    expect(JSON.stringify(body)).not.toContain('123e4567'); // cero fuga interna
    expect(body.error.request_id).toBeTruthy();
    await app.close();
  });

  it('an unexpected exception is an opaque internal_error (no leakage)', async () => {
    const app = buildApp({ config: loadConfig({}), appPool });
    app.get('/boom-internal', async () => {
      throw new Error('secret connection string postgres://x:y@z');
    });
    const res = await app.inject({ method: 'GET', url: '/boom-internal' });
    expect(res.statusCode).toBe(500);
    const body = res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('internal_error');
    expect(body.error.message).toBe('Internal server error');
    expect(JSON.stringify(body)).not.toContain('postgres://');
    await app.close();
  });

  it('malformed JSON and unknown routes go through the catalog too', async () => {
    const app = buildApp({ config: loadConfig({}), appPool });
    const badJson = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: '{"broken',
    });
    expect(badJson.statusCode).toBe(400);
    expect((badJson.json() as { error: { code: string } }).error.code).toBe('invalid_json');

    const missing = await app.inject({ method: 'GET', url: '/nope' });
    expect(missing.statusCode).toBe(404);
    const body = missing.json() as { error: { type: string; code: string; message: string } };
    expect(body.error).toMatchObject({
      type: 'not_found_error',
      code: 'not_found',
      message: ERROR_CATALOG.not_found.message,
    });
    await app.close();
  });

  it('Fastify itself never leaks its default error shape (statusCode/error keys)', async () => {
    // Control: una app Fastify cruda SI expone su forma por defecto; la
    // nuestra debe responder SIEMPRE con el sobre { error: {...} } del catalogo.
    const raw = Fastify();
    raw.get('/x', async () => {
      throw new Error('boom');
    });
    const rawRes = await raw.inject({ method: 'GET', url: '/x' });
    expect(rawRes.json()).toHaveProperty('statusCode'); // forma default de Fastify
    await raw.close();

    const app = buildApp({ config: loadConfig({}), appPool });
    app.get('/x', async () => {
      throw new Error('boom');
    });
    const res = await app.inject({ method: 'GET', url: '/x' });
    expect(res.json()).not.toHaveProperty('statusCode');
    expect(res.json()).toHaveProperty('error.code');
    await app.close();
  });
});
