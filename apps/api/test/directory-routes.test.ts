import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@fluvia/config';
import { createPool, type Pool } from '@fluvia/db';
import { AuthService } from '@fluvia/auth';
import { ApiKeyService, IdentityService } from '@fluvia/identity';
import { buildApp } from '../src/app.js';

/**
 * Directorio «Dónde comprar» contra PostgreSQL real:
 *  - visibilidad EXPLÍCITA (borrador invisible; publicar exige confirmación);
 *  - lectura pública sin ids internos ni perfiles de comercios congelados;
 *  - aislamiento: otra organización no ve ni edita perfiles ajenos;
 *  - RBAC (finance/read_only no publican) y auditoría en la misma transacción;
 *  - búsqueda con caracteres comodín escapados.
 */

let app: FastifyInstance;
let appPool: Pool;
let authPool: Pool;
let adminPool: Pool;
let orgA: string;
let orgB: string;
let merchantA: string;
let merchantB: string;

const PASSWORD = 'directory password 77';
type Headers = Record<string, string>;
let owner: { headers: Headers };
let finance: { headers: Headers };
let ownerB: { headers: Headers };

async function sessionUser(role: string, orgId: string) {
  const email = `dir-${randomUUID().slice(0, 12)}@example.com`;
  const reg = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email, password: PASSWORD },
  });
  const { user_id, verification_token } = reg.json();
  await app.inject({
    method: 'POST',
    url: '/v1/auth/verify-email',
    payload: { token: verification_token },
  });
  await adminPool.query('INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)', [
    orgId,
    user_id,
    role,
  ]);
  const login = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email, password: PASSWORD },
  });
  return { headers: { authorization: `Bearer ${login.json().session_token as string}` } };
}

async function createOrg(name: string): Promise<string> {
  const res = await adminPool.query<{ id: string }>(
    'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id',
    [name, `org-${randomUUID()}`]
  );
  return res.rows[0]!.id;
}

async function createMerchant(org: string, name: string): Promise<string> {
  const m = await adminPool.query<{ id: string }>(
    `INSERT INTO merchants (tenant_id, name) VALUES ($1, $2) RETURNING id`,
    [org, name]
  );
  return m.rows[0]!.id;
}

const suffix = randomUUID().slice(0, 8);
const slugA = `bodega-a-${suffix}`;

beforeAll(async () => {
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' });
  appPool = createPool({ connectionString: config.db.app, max: 6 });
  authPool = createPool({ connectionString: config.db.auth, max: 4 });
  adminPool = createPool({ connectionString: config.db.admin, max: 2 });
  app = buildApp({
    config,
    appPool,
    authService: new AuthService(authPool),
    identityService: new IdentityService(appPool),
    apiKeyService: new ApiKeyService(appPool),
    authRateLimits: {
      loginPerEmail: { max: 10_000, windowMs: 60_000 },
      loginPerIp: { max: 10_000, windowMs: 60_000 },
      registerPerIp: { max: 10_000, windowMs: 60_000 },
      mfaPerIp: { max: 10_000, windowMs: 60_000 },
    },
  });
  await app.ready();
  orgA = await createOrg('Directorio A');
  orgB = await createOrg('Directorio B');
  merchantA = await createMerchant(orgA, 'Razón social privada A');
  merchantB = await createMerchant(orgB, 'Razón social privada B');
  owner = await sessionUser('owner', orgA);
  finance = await sessionUser('finance', orgA);
  ownerB = await sessionUser('owner', orgB);
}, 40_000);

afterAll(async () => {
  await app.close();
  await Promise.all([appPool.end(), authPool.end(), adminPool.end()]);
});

const base = (org: string) => `/v1/organizations/${org}/directory/profiles`;
const profileBody = (slug: string, expected_version: number, extra: object = {}) => ({
  slug,
  display_name: `Bodega ${suffix}`,
  category: 'alimentacion',
  city: `Ciudad ${suffix}`,
  area: 'Centro',
  summary: 'Víveres y frutas 100% frescas',
  channels: ['in_store'],
  photo_ref: 'presentacion/bodega-demo.jpg',
  expected_version,
  ...extra,
});

async function publicSearch(query: string) {
  const res = await app.inject({ method: 'GET', url: `/v1/public/directory?${query}` });
  expect(res.statusCode).toBe(200);
  return res.json().data as Array<Record<string, unknown>>;
}

describe('directorio: visibilidad explícita', () => {
  it('un perfil nace en borrador y NO aparece en el directorio público', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `${base(orgA)}/${merchantA}`,
      headers: owner.headers,
      payload: profileBody(slugA, 0),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ visibility: 'draft', version: 1, published_at: null });
    expect(await publicSearch(`city=${encodeURIComponent(`Ciudad ${suffix}`)}`)).toEqual([]);
    const one = await app.inject({ method: 'GET', url: `/v1/public/directory/${slugA}` });
    expect(one.statusCode).toBe(404);
  });

  it('publicar exige confirm_public: true', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${base(orgA)}/${merchantA}/publish`,
      headers: owner.headers,
      payload: { expected_version: 1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('finance no puede publicar (merchants:write)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${base(orgA)}/${merchantA}/publish`,
      headers: finance.headers,
      payload: { confirm_public: true, expected_version: 1 },
    });
    expect(res.statusCode).toBe(403);
  });

  it('publicado: aparece con columnas públicas y SIN ids ni razón social', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${base(orgA)}/${merchantA}/publish`,
      headers: owner.headers,
      payload: { confirm_public: true, expected_version: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ visibility: 'published', version: 2 });

    const list = await publicSearch(`city=${encodeURIComponent(`ciudad ${suffix}`)}`);
    expect(list).toHaveLength(1);
    const entry = list[0]!;
    expect(Object.keys(entry).sort()).toEqual(
      [
        'object',
        'slug',
        'display_name',
        'category',
        'city',
        'area',
        'summary',
        'channels',
        'photo_ref',
        'is_demo',
        'published_at',
      ].sort()
    );
    const raw = JSON.stringify(entry);
    expect(raw).not.toContain(orgA);
    expect(raw).not.toContain(merchantA);
    expect(raw).not.toContain('Razón social');

    const one = await app.inject({ method: 'GET', url: `/v1/public/directory/${slugA}` });
    expect(one.statusCode).toBe(200);
    expect(one.json().display_name).toBe(`Bodega ${suffix}`);

    const audit = await adminPool.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE tenant_id = $1 AND resource_type = 'directory_profile'
        ORDER BY created_at`,
      [orgA]
    );
    expect(audit.rows.map((r) => r.action)).toEqual([
      'directory_profile.saved',
      'directory_profile.published',
    ]);
  });

  it('versión obsoleta → 409 directory_version_conflict', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `${base(orgA)}/${merchantA}`,
      headers: owner.headers,
      payload: profileBody(slugA, 1),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('directory_version_conflict');
  });

  it('búsqueda: los comodines del usuario se escapan', async () => {
    const hit = await publicSearch(
      `q=${encodeURIComponent('100% frescas')}&city=${encodeURIComponent(`Ciudad ${suffix}`)}`
    );
    expect(hit).toHaveLength(1);
    const miss = await publicSearch(
      `q=${encodeURIComponent('%')}&city=${encodeURIComponent(`Ciudad ${suffix}`)}`
    );
    // «%» literal: el resumen contiene «100%», así que coincide como texto.
    expect(miss).toHaveLength(1);
    const underscore = await publicSearch(`q=_&city=${encodeURIComponent(`Ciudad ${suffix}`)}`);
    expect(underscore).toEqual([]);
  });

  it('comercio congelado: su perfil publicado deja de verse', async () => {
    await adminPool.query(`UPDATE merchants SET status = 'frozen' WHERE id = $1`, [merchantA]);
    try {
      const one = await app.inject({ method: 'GET', url: `/v1/public/directory/${slugA}` });
      expect(one.statusCode).toBe(404);
    } finally {
      await adminPool.query(`UPDATE merchants SET status = 'active' WHERE id = $1`, [merchantA]);
    }
  });

  it('retirar (hide) lo saca del directorio público', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${base(orgA)}/${merchantA}/hide`,
      headers: owner.headers,
      payload: { expected_version: 2 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ visibility: 'hidden', published_at: null });
    const one = await app.inject({ method: 'GET', url: `/v1/public/directory/${slugA}` });
    expect(one.statusCode).toBe(404);
  });
});

describe('directorio: aislamiento entre organizaciones', () => {
  it('otra organización no lista ni edita el perfil ajeno', async () => {
    const list = await app.inject({ method: 'GET', url: base(orgB), headers: ownerB.headers });
    expect(list.statusCode).toBe(200);
    expect(list.json().data).toEqual([]);

    // Intenta escribir sobre el comercio de A desde su propia organización.
    const cross = await app.inject({
      method: 'PUT',
      url: `${base(orgB)}/${merchantA}`,
      headers: ownerB.headers,
      payload: profileBody(`intruso-${suffix}`, 0),
    });
    expect(cross.statusCode).toBe(404);

    // Y no puede usar la organización de A en la URL.
    const foreign = await app.inject({
      method: 'GET',
      url: base(orgA),
      headers: ownerB.headers,
    });
    expect(foreign.statusCode).toBe(404);
  });

  it('el slug es único globalmente', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `${base(orgB)}/${merchantB}`,
      headers: ownerB.headers,
      payload: profileBody(slugA, 0),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('directory_slug_taken');
  });

  it('una foto fuera del conjunto cerrado se rechaza', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `${base(orgB)}/${merchantB}`,
      headers: ownerB.headers,
      payload: profileBody(`b-${suffix}`, 0, { photo_ref: 'https://example.com/x.jpg' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('el rol de la app no lee perfiles de otro tenant ni sin contexto (RLS)', async () => {
    const c = await appPool.connect();
    try {
      const none = await c.query('SELECT count(*)::int AS n FROM merchant_directory_profiles');
      expect(none.rows[0].n).toBe(0);
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [orgB]);
      const b = await c.query('SELECT slug FROM merchant_directory_profiles');
      expect(b.rows.map((r) => r.slug)).not.toContain(slugA);
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  });
});
