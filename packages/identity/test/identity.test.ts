import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenantTransaction } from '@fluvia/db';
import { createTestContext, type TestContext } from '@fluvia/db/testing';
import {
  EmailTakenError,
  IdentityService,
  MerchantNameTakenError,
  MerchantNotFoundError,
  OrganizationNotFoundError,
  OrganizationSlugTakenError,
  createOrganizationWithOwner,
} from '../src/index.js';

let ctx: TestContext;
let service: IdentityService;

const uniqueSlug = () => `acme-${randomUUID().slice(0, 12)}`;
const uniqueEmail = () => `owner-${randomUUID().slice(0, 12)}@example.com`;

beforeAll(async () => {
  ctx = await createTestContext();
  service = new IdentityService(ctx.app);
}, 30_000);

afterAll(async () => {
  await ctx.close();
});

describe('createOrganizationWithOwner (plano de plataforma)', () => {
  it('creates organization + user + owner membership atomically', async () => {
    const created = await createOrganizationWithOwner(ctx.admin, {
      organizationName: 'Acme Corp',
      slug: uniqueSlug(),
      ownerEmail: uniqueEmail(),
    });
    expect(created.organizationId).toBeTruthy();

    const members = await service.listMembers(created.organizationId);
    expect(members).toHaveLength(1);
    expect(members[0]!.role).toBe('owner');
    expect(members[0]!.userId).toBe(created.ownerUserId);
  });

  it('normalizes email to lowercase and rejects duplicates case-insensitively', async () => {
    const email = uniqueEmail();
    await createOrganizationWithOwner(ctx.admin, {
      organizationName: 'First Org',
      slug: uniqueSlug(),
      ownerEmail: email,
    });
    await expect(
      createOrganizationWithOwner(ctx.admin, {
        organizationName: 'Second Org',
        slug: uniqueSlug(),
        ownerEmail: email.toUpperCase(),
      })
    ).rejects.toThrow(EmailTakenError);
  });

  it('rejects duplicate slugs and rolls back the whole transaction', async () => {
    const slug = uniqueSlug();
    const email = uniqueEmail();
    await createOrganizationWithOwner(ctx.admin, {
      organizationName: 'Org A',
      slug,
      ownerEmail: uniqueEmail(),
    });
    await expect(
      createOrganizationWithOwner(ctx.admin, {
        organizationName: 'Org B',
        slug,
        ownerEmail: email,
      })
    ).rejects.toThrow(OrganizationSlugTakenError);
    // Rollback total: el usuario del intento fallido NO debe existir.
    const orphan = await ctx.admin.query('SELECT 1 FROM users WHERE email = $1', [
      email.toLowerCase(),
    ]);
    expect(orphan.rowCount).toBe(0);
  });

  it('rejects malformed input (strict schemas)', async () => {
    await expect(
      createOrganizationWithOwner(ctx.admin, {
        organizationName: 'X',
        slug: uniqueSlug(),
        ownerEmail: uniqueEmail(),
      })
    ).rejects.toThrow(); // nombre demasiado corto
    await expect(
      createOrganizationWithOwner(ctx.admin, {
        organizationName: 'Valid Name',
        slug: 'Bad_Slug!',
        ownerEmail: uniqueEmail(),
      })
    ).rejects.toThrow();
    await expect(
      createOrganizationWithOwner(ctx.admin, {
        organizationName: 'Valid Name',
        slug: uniqueSlug(),
        ownerEmail: 'not-an-email',
      })
    ).rejects.toThrow();
  });
});

describe('IdentityService (plano de tenant, RLS activo)', () => {
  let orgA: string;
  let orgB: string;

  beforeAll(async () => {
    orgA = (
      await createOrganizationWithOwner(ctx.admin, {
        organizationName: 'Tenant A',
        slug: uniqueSlug(),
        ownerEmail: uniqueEmail(),
      })
    ).organizationId;
    orgB = (
      await createOrganizationWithOwner(ctx.admin, {
        organizationName: 'Tenant B',
        slug: uniqueSlug(),
        ownerEmail: uniqueEmail(),
      })
    ).organizationId;
  });

  it('getOrganization returns only the tenant own organization', async () => {
    const org = await service.getOrganization(orgA);
    expect(org.id).toBe(orgA);
    expect(org.name).toBe('Tenant A');
  });

  it('creates merchants with Colombia defaults (CO / COP)', async () => {
    const merchant = await service.createMerchant(orgA, { name: 'Tienda Bogotá' });
    expect(merchant.country).toBe('CO');
    expect(merchant.defaultCurrency).toBe('COP');
    expect(merchant.status).toBe('active');
  });

  it('rejects duplicate merchant name within the tenant, allows it across tenants', async () => {
    await service.createMerchant(orgA, { name: 'Sucursal Norte' });
    await expect(service.createMerchant(orgA, { name: 'Sucursal Norte' })).rejects.toThrow(
      MerchantNameTakenError
    );
    await expect(service.createMerchant(orgB, { name: 'Sucursal Norte' })).resolves.toBeTruthy();
  });

  it('rejects unsupported currencies and unknown fields (strict DTO)', async () => {
    await expect(
      service.createMerchant(orgA, { name: 'Mal Comercio', defaultCurrency: 'XXX' as never })
    ).rejects.toThrow();
    await expect(
      service.createMerchant(orgA, { name: 'Mal Comercio', isAdmin: true } as never)
    ).rejects.toThrow();
  });

  it('merchant listing and lookup are tenant-isolated', async () => {
    const b = await service.createMerchant(orgB, { name: 'Solo De B' });
    const listA = await service.listMerchants(orgA);
    expect(listA.some((m) => m.id === b.id)).toBe(false);
    await expect(service.getMerchant(orgA, b.id)).rejects.toThrow(MerchantNotFoundError);
    await expect(service.getMerchant(orgB, b.id)).resolves.toBeTruthy();
  });

  it('updateMerchant renames within the tenant only', async () => {
    const m = await service.createMerchant(orgA, { name: 'Nombre Viejo' });
    const updated = await service.updateMerchant(orgA, m.id, { name: 'Nombre Nuevo' });
    expect(updated.name).toBe('Nombre Nuevo');
    await expect(service.updateMerchant(orgB, m.id, { name: 'Hack' })).rejects.toThrow(
      MerchantNotFoundError
    );
  });

  it('cross-tenant organization lookup fails as not-found (indistinguible)', async () => {
    await expect(
      withTenantTransaction(ctx.app, orgA, async (c) => {
        const res = await c.query('SELECT id FROM organizations WHERE id = $1', [orgB]);
        return res.rowCount;
      })
    ).resolves.toBe(0);
    await expect(service.getOrganization(randomUUID())).rejects.toThrow(OrganizationNotFoundError);
  });
});

describe('users bajo RLS (tabla global)', () => {
  it('a tenant only sees users that share an active membership', async () => {
    const a = await createOrganizationWithOwner(ctx.admin, {
      organizationName: 'Org Vista',
      slug: uniqueSlug(),
      ownerEmail: uniqueEmail(),
    });
    const b = await createOrganizationWithOwner(ctx.admin, {
      organizationName: 'Org Oculta',
      slug: uniqueSlug(),
      ownerEmail: uniqueEmail(),
    });
    const visibleFromA = await withTenantTransaction(ctx.app, a.organizationId, async (c) => {
      const own = await c.query('SELECT 1 FROM users WHERE id = $1', [a.ownerUserId]);
      const foreign = await c.query('SELECT 1 FROM users WHERE id = $1', [b.ownerUserId]);
      return { own: own.rowCount, foreign: foreign.rowCount };
    });
    expect(visibleFromA.own).toBe(1);
    expect(visibleFromA.foreign).toBe(0);
  });

  it('the app role cannot INSERT users (writes are platform-plane only)', async () => {
    const org = await ctx.createTenant();
    await expect(
      withTenantTransaction(ctx.app, org, (c) =>
        c.query('INSERT INTO users (email) VALUES ($1)', [uniqueEmail()])
      )
    ).rejects.toThrow(/row-level security|permission denied/i);
  });
});

describe('inmutabilidad de las tablas nuevas', () => {
  it('DELETE is forbidden on users, memberships and merchants', async () => {
    await expect(ctx.admin.query('DELETE FROM users')).rejects.toThrow(/FLUVIA_IMMUTABLE/);
    await expect(ctx.admin.query('DELETE FROM memberships')).rejects.toThrow(/FLUVIA_IMMUTABLE/);
    await expect(ctx.admin.query('DELETE FROM merchants')).rejects.toThrow(/FLUVIA_IMMUTABLE/);
  });
});

describe('authenticate_api_key tras el rename a organizations', () => {
  it('still resolves tenants from key hashes', async () => {
    const org = await ctx.createTenant();
    const key = await ctx.createApiKey(org);
    const { hashApiKey } = await import('@fluvia/db/testing');
    const client = await ctx.app.connect();
    try {
      const res = await client.query<{ tenant_id: string }>(
        'SELECT tenant_id FROM authenticate_api_key($1)',
        [hashApiKey(key)]
      );
      expect(res.rows[0]?.tenant_id).toBe(org);
    } finally {
      client.release();
    }
  });
});
