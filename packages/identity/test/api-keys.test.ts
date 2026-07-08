import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '@fluvia/db/testing';
import {
  ApiKeyNotFoundError,
  ApiKeyService,
  LiveKeysDisabledError,
  DEV_API_KEY_HMAC_SECRET_HEX,
  apiKeyPepperFingerprint,
  backfillApiKeyPepperFp,
  hashApiKeySecret,
  hmacApiKeySecret,
  inspectApiKeyPepper,
} from '../src/index.js';

let ctx: TestContext;
let service: ApiKeyService;
let orgA: string;
let orgB: string;

/** Huella del pepper ACTUAL (DEV) — la que fija create y el re-hash perezoso. */
const CUR_FP = apiKeyPepperFingerprint(DEV_API_KEY_HMAC_SECRET_HEX);

beforeAll(async () => {
  ctx = await createTestContext();
  service = new ApiKeyService(ctx.app);
  orgA = await ctx.createTenant();
  orgB = await ctx.createTenant();
}, 30_000);

afterAll(async () => {
  await ctx.close();
});

describe('ApiKeyService (F1-04c)', () => {
  it('creates a key returning the secret exactly once, storing only hash + prefix', async () => {
    const created = await service.create(orgA, { label: 'backend', scopes: ['read'] });
    expect(created.secret).toMatch(/^fluvia_sk_test_[0-9a-f]{48}$/);
    expect(created.keyPrefix).toBe(created.secret.slice(0, 20));

    const stored = await ctx.admin.query<{
      key_hash: string;
      key_prefix: string;
      key_hash_version: number;
      key_hash_pepper_fp: string;
    }>(
      'SELECT key_hash, key_prefix, key_hash_version, key_hash_pepper_fp FROM api_keys WHERE id = $1',
      [created.id]
    );
    expect(stored.rows[0]!.key_hash_version).toBe(2);
    // AUD-P2-015: el hash almacenado es HMAC v2 con pepper de servidor — un
    // dump de la tabla (sin pepper) ya no permite validar claves offline.
    expect(stored.rows[0]!.key_hash).toBe(
      hmacApiKeySecret(DEV_API_KEY_HMAC_SECRET_HEX, created.secret)
    );
    expect(stored.rows[0]!.key_hash).not.toBe(hashApiKeySecret(created.secret));
    expect(stored.rows[0]!.key_hash).not.toContain(created.secret);
    expect(stored.rows[0]!.key_prefix.length).toBeLessThan(created.secret.length);
    // F6: create fija la huella del pepper ACTUAL (para el gate de rotación).
    expect(stored.rows[0]!.key_hash_pepper_fp).toBe(CUR_FP);
  });

  // AUD-P2-003: no existe plano live -> emitir keys live seria declarar una
  // capacidad inexistente. Se rechaza SIEMPRE hasta pasar production gates.
  it('refuses to create live-environment keys while no live plane exists', async () => {
    await expect(
      service.create(orgA, { label: 'prod-ish', scopes: ['read'], environment: 'live' })
    ).rejects.toThrow(LiveKeysDisabledError);

    const stored = await ctx.admin.query(
      `SELECT 1 FROM api_keys WHERE tenant_id = $1 AND environment = 'live'`,
      [orgA]
    );
    expect(stored.rowCount).toBe(0);
  });

  it('validates scopes strictly (unknown, duplicate, empty, extra fields)', async () => {
    await expect(
      service.create(orgA, { label: 'x', scopes: ['admin'] as never })
    ).rejects.toThrow();
    await expect(
      service.create(orgA, { label: 'x', scopes: ['read', 'read'] as never })
    ).rejects.toThrow();
    await expect(service.create(orgA, { label: 'x', scopes: [] as never })).rejects.toThrow();
    await expect(
      service.create(orgA, { label: 'x', scopes: ['read'], superuser: true } as never)
    ).rejects.toThrow();
  });

  it('list exposes metadata but never the secret', async () => {
    const created = await service.create(orgA, {
      label: 'listable',
      scopes: ['read', 'payments:write'],
    });
    const keys = await service.list(orgA);
    const found = keys.find((k) => k.id === created.id);
    expect(found).toBeTruthy();
    expect(found!.keyPrefix).toBe(created.keyPrefix);
    expect(JSON.stringify(keys)).not.toContain(created.secret);
    expect(found!.scopes.sort()).toEqual(['payments:write', 'read']);
  });

  it('is tenant-isolated: org B cannot list nor revoke org A keys', async () => {
    const created = await service.create(orgA, { label: 'a-only', scopes: ['read'] });
    const bKeys = await service.list(orgB);
    expect(bKeys.some((k) => k.id === created.id)).toBe(false);
    await expect(service.revoke(orgB, created.id)).rejects.toThrow(ApiKeyNotFoundError);
  });

  it('revoke disables authentication for the key', async () => {
    const created = await service.create(orgA, { label: 'to-revoke', scopes: ['read'] });
    const before = await ctx.app.query('SELECT * FROM authenticate_api_key($1, $2, $3, $4)', [
      hmacApiKeySecret(DEV_API_KEY_HMAC_SECRET_HEX, created.secret),
      hashApiKeySecret(created.secret),
      [],
      CUR_FP,
    ]);
    expect(before.rowCount).toBe(1);
    await service.revoke(orgA, created.id);
    const after = await ctx.app.query('SELECT * FROM authenticate_api_key($1, $2, $3, $4)', [
      hmacApiKeySecret(DEV_API_KEY_HMAC_SECRET_HEX, created.secret),
      hashApiKeySecret(created.secret),
      [],
      CUR_FP,
    ]);
    expect(after.rowCount).toBe(0);
  });

  it('authenticate_api_key returns scopes and environment and touches last_used_at', async () => {
    const created = await service.create(orgA, {
      label: 'auth-check',
      scopes: ['read', 'webhooks:manage'],
    });
    const res = await ctx.app.query<{
      tenant_id: string;
      scopes: string[];
      environment: string;
    }>('SELECT * FROM authenticate_api_key($1, $2, $3, $4)', [
      hmacApiKeySecret(DEV_API_KEY_HMAC_SECRET_HEX, created.secret),
      hashApiKeySecret(created.secret),
      [],
      CUR_FP,
    ]);
    expect(res.rows[0]!.tenant_id).toBe(orgA);
    expect(res.rows[0]!.scopes.sort()).toEqual(['read', 'webhooks:manage']);
    expect(res.rows[0]!.environment).toBe('test');

    const touched = await ctx.admin.query<{ last_used_at: Date | null }>(
      'SELECT last_used_at FROM api_keys WHERE id = $1',
      [created.id]
    );
    expect(touched.rows[0]!.last_used_at).not.toBeNull();
  });

  it('AUD-P2-015: a legacy sha256 key authenticates AND is upgraded to HMAC v2 in the same call', async () => {
    const created = await service.create(orgA, { label: 'legacy-sim', scopes: ['read'] });
    // Simula una fila pre-0016: sha256 puro, version 1, sin huella de pepper.
    await ctx.admin.query(
      `UPDATE api_keys SET key_hash = $2, key_hash_version = 1, key_hash_pepper_fp = NULL WHERE id = $1`,
      [created.id, hashApiKeySecret(created.secret)]
    );

    const hmac = hmacApiKeySecret(DEV_API_KEY_HMAC_SECRET_HEX, created.secret);
    const res = await ctx.app.query('SELECT * FROM authenticate_api_key($1, $2, $3, $4)', [
      hmac,
      hashApiKeySecret(created.secret),
      [],
      CUR_FP,
    ]);
    expect(res.rowCount).toBe(1);

    // La fila quedo promovida: hash HMAC + version 2 + huella del pepper actual, sin re-emision.
    const row = await ctx.admin.query<{
      key_hash: string;
      key_hash_version: number;
      key_hash_pepper_fp: string;
    }>('SELECT key_hash, key_hash_version, key_hash_pepper_fp FROM api_keys WHERE id = $1', [
      created.id,
    ]);
    expect(row.rows[0]!.key_hash_version).toBe(2);
    expect(row.rows[0]!.key_hash).toBe(hmac);
    expect(row.rows[0]!.key_hash_pepper_fp).toBe(CUR_FP);

    // Y autentica por la via v2 (el sha256 legado ya NO matchea ninguna fila).
    const again = await ctx.app.query('SELECT * FROM authenticate_api_key($1, $2, $3, $4)', [
      hmac,
      'not-a-real-legacy-hash',
      [],
      CUR_FP,
    ]);
    expect(again.rowCount).toBe(1);
    const legacyOnly = await ctx.app.query('SELECT * FROM authenticate_api_key($1, $2, $3, $4)', [
      'not-a-real-hmac',
      hashApiKeySecret(created.secret),
      [],
      CUR_FP,
    ]);
    expect(legacyOnly.rowCount).toBe(0);
  });
});

describe('rotación del pepper HMAC de API keys (F6, ADR-0012 — huella + re-hash perezoso)', () => {
  const OLD_PEPPER = '5a'.repeat(32);
  const OLD_FP = apiKeyPepperFingerprint(OLD_PEPPER);

  it('una key bajo el pepper RETIRADO autentica y se RE-HASHEA al actual (fijando la huella)', async () => {
    // Crea la key con el pepper VIEJO → hash + huella bajo OLD.
    const svcOld = new ApiKeyService(ctx.app, { hmacSecretHex: OLD_PEPPER });
    const created = await svcOld.create(orgA, { label: 'old-pepper', scopes: ['read'] });
    const before = await ctx.admin.query<{ key_hash: string; key_hash_pepper_fp: string }>(
      'SELECT key_hash, key_hash_pepper_fp FROM api_keys WHERE id = $1',
      [created.id]
    );
    expect(before.rows[0]!.key_hash_pepper_fp).toBe(OLD_FP);
    expect(before.rows[0]!.key_hash).toBe(hmacApiKeySecret(OLD_PEPPER, created.secret));

    // Autentica con actual=DEV, retirado=[OLD]: matchea por el retirado y re-hashea a DEV.
    const res = await ctx.app.query('SELECT * FROM authenticate_api_key($1, $2, $3, $4)', [
      hmacApiKeySecret(DEV_API_KEY_HMAC_SECRET_HEX, created.secret),
      hashApiKeySecret(created.secret),
      [hmacApiKeySecret(OLD_PEPPER, created.secret)],
      CUR_FP,
    ]);
    expect(res.rowCount).toBe(1);

    const after = await ctx.admin.query<{
      key_hash: string;
      key_hash_version: number;
      key_hash_pepper_fp: string;
    }>('SELECT key_hash, key_hash_version, key_hash_pepper_fp FROM api_keys WHERE id = $1', [
      created.id,
    ]);
    expect(after.rows[0]!.key_hash_version).toBe(2);
    expect(after.rows[0]!.key_hash).toBe(
      hmacApiKeySecret(DEV_API_KEY_HMAC_SECRET_HEX, created.secret)
    );
    expect(after.rows[0]!.key_hash_pepper_fp).toBe(CUR_FP);

    // Tras el re-hash, autentica con SOLO el actual (retirado eliminado): la migración cerró.
    const soloCurrent = await ctx.app.query('SELECT * FROM authenticate_api_key($1, $2, $3, $4)', [
      hmacApiKeySecret(DEV_API_KEY_HMAC_SECRET_HEX, created.secret),
      hashApiKeySecret(created.secret),
      [],
      CUR_FP,
    ]);
    expect(soloCurrent.rowCount).toBe(1);
  });

  it('inspect: el gate cuenta las keys bajo el pepper retirado y baja a 0 al re-hashear', async () => {
    const org = await ctx.createTenant();
    const svcOld = new ApiKeyService(ctx.app, { hmacSecretHex: OLD_PEPPER });
    const s1 = await svcOld.create(org, { label: 's1', scopes: ['read'] });
    const s2 = await svcOld.create(org, { label: 's2', scopes: ['read'] });
    await service.create(org, { label: 'cur', scopes: ['read'] });

    let st = await inspectApiKeyPepper(ctx.admin, {
      currentFp: CUR_FP,
      retiredFps: [OLD_FP],
      tenantIds: [org],
    });
    expect(st.total).toBe(3);
    expect(st.underCurrent).toBe(1);
    expect(st.underRetired).toBe(2);
    expect(st.unmarked).toBe(0);
    expect(st.unknown).toBe(0);
    expect(st.stragglerIds.length).toBe(2);

    // Autentica ambas (re-hash perezoso al pepper actual) → el gate llega a 0 bajo la retirada.
    for (const s of [s1, s2]) {
      await ctx.app.query('SELECT * FROM authenticate_api_key($1, $2, $3, $4)', [
        hmacApiKeySecret(DEV_API_KEY_HMAC_SECRET_HEX, s.secret),
        hashApiKeySecret(s.secret),
        [hmacApiKeySecret(OLD_PEPPER, s.secret)],
        CUR_FP,
      ]);
    }
    st = await inspectApiKeyPepper(ctx.admin, {
      currentFp: CUR_FP,
      retiredFps: [OLD_FP],
      tenantIds: [org],
    });
    expect(st.underRetired).toBe(0);
    expect(st.underCurrent).toBe(3);
  }, 30_000);

  it('un pepper FUERA del keyring se reporta como unknown (no matchea → no autentica)', async () => {
    const org = await ctx.createTenant();
    const stray = 'cc'.repeat(32); // ni actual ni retirado
    const svcStray = new ApiKeyService(ctx.app, { hmacSecretHex: stray });
    const created = await svcStray.create(org, { label: 'stray', scopes: ['read'] });
    const st = await inspectApiKeyPepper(ctx.admin, {
      currentFp: CUR_FP,
      retiredFps: [OLD_FP],
      tenantIds: [org],
    });
    expect(st.unknown).toBe(1);
    expect(st.stragglerIds).toContain(created.id);
    // Con actual=DEV y retirado=[OLD], la key stray NO autentica (su pepper no está).
    const res = await ctx.app.query('SELECT * FROM authenticate_api_key($1, $2, $3, $4)', [
      hmacApiKeySecret(DEV_API_KEY_HMAC_SECRET_HEX, created.secret),
      hashApiKeySecret(created.secret),
      [hmacApiKeySecret(OLD_PEPPER, created.secret)],
      CUR_FP,
    ]);
    expect(res.rowCount).toBe(0);
  });

  it('backfill marca las filas v2 sin huella como bajo el pepper actual', async () => {
    const org = await ctx.createTenant();
    const created = await service.create(org, { label: 'bf', scopes: ['read'] });
    // Simula una fila v2 previa a 0044: huella NULL.
    await ctx.admin.query('UPDATE api_keys SET key_hash_pepper_fp = NULL WHERE id = $1', [
      created.id,
    ]);
    let st = await inspectApiKeyPepper(ctx.admin, {
      currentFp: CUR_FP,
      retiredFps: [],
      tenantIds: [org],
    });
    expect(st.unmarked).toBe(1);

    const res = await backfillApiKeyPepperFp(ctx.admin, CUR_FP, { tenantIds: [org] });
    expect(res.updated).toBeGreaterThanOrEqual(1);

    st = await inspectApiKeyPepper(ctx.admin, {
      currentFp: CUR_FP,
      retiredFps: [],
      tenantIds: [org],
    });
    expect(st.unmarked).toBe(0);
    expect(st.underCurrent).toBe(1);
  });

  it('tenantIds vacío = TODOS (no un scope vacío que daría un gate «safe» falso)', async () => {
    // Con keys de tests anteriores en la BD, `[]` debe comportarse como «global»
    // (fallar ABIERTO), no devolver todo en cero.
    const all = await inspectApiKeyPepper(ctx.admin, {
      currentFp: CUR_FP,
      retiredFps: [],
      tenantIds: [],
    });
    expect(all.total).toBeGreaterThan(0);
  });
});
