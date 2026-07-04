import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '@fluvia/db/testing';
import { ApiKeyNotFoundError, ApiKeyService, hashApiKeySecret } from '../src/index.js';

let ctx: TestContext;
let service: ApiKeyService;
let orgA: string;
let orgB: string;

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

    const stored = await ctx.admin.query<{ key_hash: string; key_prefix: string }>(
      'SELECT key_hash, key_prefix FROM api_keys WHERE id = $1',
      [created.id]
    );
    expect(stored.rows[0]!.key_hash).toBe(hashApiKeySecret(created.secret));
    expect(stored.rows[0]!.key_hash).not.toContain(created.secret);
    expect(stored.rows[0]!.key_prefix.length).toBeLessThan(created.secret.length);
  });

  it('live environment keys carry the live prefix', async () => {
    const created = await service.create(orgA, {
      label: 'prod-ish',
      scopes: ['read'],
      environment: 'live',
    });
    expect(created.secret.startsWith('fluvia_sk_live_')).toBe(true);
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
    const before = await ctx.app.query('SELECT * FROM authenticate_api_key($1)', [
      hashApiKeySecret(created.secret),
    ]);
    expect(before.rowCount).toBe(1);
    await service.revoke(orgA, created.id);
    const after = await ctx.app.query('SELECT * FROM authenticate_api_key($1)', [
      hashApiKeySecret(created.secret),
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
    }>('SELECT * FROM authenticate_api_key($1)', [hashApiKeySecret(created.secret)]);
    expect(res.rows[0]!.tenant_id).toBe(orgA);
    expect(res.rows[0]!.scopes.sort()).toEqual(['read', 'webhooks:manage']);
    expect(res.rows[0]!.environment).toBe('test');

    const touched = await ctx.admin.query<{ last_used_at: Date | null }>(
      'SELECT last_used_at FROM api_keys WHERE id = $1',
      [created.id]
    );
    expect(touched.rows[0]!.last_used_at).not.toBeNull();
  });
});
