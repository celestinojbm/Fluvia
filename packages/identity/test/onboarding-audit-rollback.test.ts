import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestContext, type TestContext } from '@fluvia/db/testing';

/**
 * F6.5C2 — atomicidad ante FALLO DE AUDITORIA (patron RA-F65B-003 /
 * register-sandbox-audit-rollback): se envuelve `insertAuditEvent` para que
 * lance SOLO cuando el test lo pide (por accion), sin hooks de produccion.
 * El fallo ocurre DENTRO de la transaccion de plataforma => rollback COMPLETO
 * de organizacion, membership y del audit previo que si se habia insertado.
 *
 * Archivo separado: `vi.mock` es por-modulo-de-test y no debe contaminar las
 * demas suites de identity.
 */

const failure = vi.hoisted(() => ({ action: null as string | null }));

vi.mock('@fluvia/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluvia/audit')>();
  return {
    ...actual,
    insertAuditEvent: async (
      client: Parameters<typeof actual.insertAuditEvent>[0],
      event: Parameters<typeof actual.insertAuditEvent>[1]
    ) => {
      if (failure.action !== null && event.action === failure.action) {
        throw new Error(`injected audit failure: ${event.action}`);
      }
      return actual.insertAuditEvent(client, event);
    },
  };
});

// Import DESPUES del mock: el modulo bajo test debe resolver el interceptado.
const { createOrganizationForUser } = await import('../src/index.js');
const { IdentityService } = await import('../src/index.js');

let ctx: TestContext;
let service: InstanceType<typeof IdentityService>;

const uniqueSlug = () => `onb-rb-${randomUUID().slice(0, 10)}`;
const uniqueEmail = () => `onb-rb-${randomUUID().slice(0, 10)}@example.com`;

const audit = (userId: string, requestId: string) => ({
  actorType: 'user' as const,
  actorId: userId,
  authMethod: 'session' as const,
  requestId,
});

async function createVerifiedUser(): Promise<string> {
  const res = await ctx.admin.query<{ id: string }>(
    'INSERT INTO users (email, email_verified_at) VALUES ($1, now()) RETURNING id',
    [uniqueEmail()]
  );
  return res.rows[0]!.id;
}

async function ownedOrgCount(userId: string): Promise<number> {
  const res = await ctx.admin.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM memberships WHERE user_id = $1 AND role = 'owner'`,
    [userId]
  );
  return Number(res.rows[0]!.n);
}

async function auditCount(requestId: string): Promise<number> {
  const res = await ctx.admin.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM audit_events WHERE request_id = $1',
    [requestId]
  );
  return Number(res.rows[0]!.n);
}

beforeAll(async () => {
  ctx = await createTestContext();
  service = new IdentityService(ctx.app);
}, 30_000);

afterAll(async () => {
  await ctx.close();
});

afterEach(() => {
  failure.action = null;
});

describe('createOrganizationForUser — fallo de cualquiera de los dos audits => rollback completo', () => {
  it('failure of organization.created rolls back org and membership', async () => {
    failure.action = 'organization.created';
    const userId = await createVerifiedUser();
    const requestId = randomUUID();
    await expect(
      createOrganizationForUser(
        ctx.admin,
        { userId, organizationName: 'Rollback Uno', slug: uniqueSlug() },
        audit(userId, requestId)
      )
    ).rejects.toThrow(/injected audit failure/);
    expect(await ownedOrgCount(userId)).toBe(0);
    expect(await auditCount(requestId)).toBe(0);
    const org = await ctx.admin.query('SELECT 1 FROM organizations WHERE name = $1', [
      'Rollback Uno',
    ]);
    expect(org.rowCount).toBe(0);
  });

  it('failure of membership.created rolls back org, membership AND the first audit', async () => {
    failure.action = 'membership.created';
    const userId = await createVerifiedUser();
    const requestId = randomUUID();
    await expect(
      createOrganizationForUser(
        ctx.admin,
        { userId, organizationName: 'Rollback Dos', slug: uniqueSlug() },
        audit(userId, requestId)
      )
    ).rejects.toThrow(/injected audit failure/);
    expect(await ownedOrgCount(userId)).toBe(0);
    // El audit organization.created (que SI llego a insertarse dentro de la
    // tx) desaparecio con el rollback.
    expect(await auditCount(requestId)).toBe(0);
    const org = await ctx.admin.query('SELECT 1 FROM organizations WHERE name = $1', [
      'Rollback Dos',
    ]);
    expect(org.rowCount).toBe(0);
  });

  it('sanity: with no injected failure the same function commits normally', async () => {
    const userId = await createVerifiedUser();
    const requestId = randomUUID();
    const result = await createOrganizationForUser(
      ctx.admin,
      { userId, organizationName: 'Rollback Sanity', slug: uniqueSlug() },
      audit(userId, requestId)
    );
    expect(result.replayed).toBe(false);
    expect(await ownedOrgCount(userId)).toBe(1);
    expect(await auditCount(requestId)).toBe(2);
  });
});

describe('ensureMerchantForOnboarding — fallo de merchant.created => rollback del merchant', () => {
  it('rolls back the merchant when the audit insert fails inside the tx', async () => {
    failure.action = 'merchant.created';
    const tenantId = await ctx.createTenant();
    const requestId = randomUUID();
    await expect(
      service.ensureMerchantForOnboarding(
        tenantId,
        { name: 'Comercio Rollback' },
        audit(randomUUID(), requestId)
      )
    ).rejects.toThrow(/injected audit failure/);
    const merchants = await ctx.admin.query('SELECT 1 FROM merchants WHERE tenant_id = $1', [
      tenantId,
    ]);
    expect(merchants.rowCount).toBe(0);
    expect(await auditCount(requestId)).toBe(0);
  });
});
