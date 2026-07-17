import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditContext } from '@fluvia/audit';
import { createTestContext, type TestContext } from '@fluvia/db/testing';
import {
  OnboardingAlreadyCompletedError,
  OnboardingEmailNotVerifiedError,
  OnboardingUserNotFoundError,
  OrganizationSlugTakenError,
  createOrganizationForUser,
} from '../src/index.js';

/**
 * F6.5C2 Paso A — `createOrganizationForUser` contra PostgreSQL real: una sola
 * transaccion de plataforma (org + membership owner + 2 audits atomicos),
 * idempotencia NATURAL serializada por el lock `FOR UPDATE` de la fila del
 * usuario (mismo payload = replay; distinto = 409; slug ajeno = conflicto
 * estable), y rechazo seguro de usuarios no verificados/inexistentes.
 */

let ctx: TestContext;

const uniqueSlug = () => `onb-${randomUUID().slice(0, 12)}`;
const uniqueEmail = () => `onb-${randomUUID().slice(0, 12)}@example.com`;

const audit = (userId: string, requestId = randomUUID()): AuditContext => ({
  actorType: 'user',
  actorId: userId,
  authMethod: 'session',
  requestId,
});

async function createUser(opts: { verified?: boolean; deleted?: boolean } = {}): Promise<string> {
  const res = await ctx.admin.query<{ id: string }>(
    `INSERT INTO users (email, email_verified_at, deleted_at)
     VALUES ($1, $2, $3) RETURNING id`,
    [uniqueEmail(), opts.verified === false ? null : new Date(), opts.deleted ? new Date() : null]
  );
  return res.rows[0]!.id;
}

async function ownedOrgCount(userId: string): Promise<number> {
  const res = await ctx.admin.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM memberships
     WHERE user_id = $1 AND role = 'owner' AND revoked_at IS NULL`,
    [userId]
  );
  return Number(res.rows[0]!.n);
}

async function auditActions(tenantId: string): Promise<string[]> {
  const res = await ctx.admin.query<{ action: string }>(
    `SELECT action FROM audit_events WHERE tenant_id = $1 ORDER BY id`,
    [tenantId]
  );
  return res.rows.map((r) => r.action);
}

beforeAll(async () => {
  ctx = await createTestContext();
}, 30_000);

afterAll(async () => {
  await ctx.close();
});

describe('creacion exitosa (org + membership owner + auditoria atomica)', () => {
  it('creates one org, one owner membership and BOTH audit events in the same tx', async () => {
    const userId = await createUser();
    const requestId = randomUUID();
    const result = await createOrganizationForUser(
      ctx.admin,
      { userId, organizationName: 'Onboarding Corp', slug: uniqueSlug() },
      audit(userId, requestId)
    );
    expect(result.replayed).toBe(false);
    expect(result.membership.role).toBe('owner');

    const org = await ctx.admin.query(
      'SELECT name, slug FROM organizations WHERE id = $1 AND deleted_at IS NULL',
      [result.organization.id]
    );
    expect(org.rowCount).toBe(1);
    expect(await ownedOrgCount(userId)).toBe(1);

    const events = await ctx.admin.query<{
      action: string;
      actor_type: string;
      actor_id: string;
      resource_type: string;
      resource_id: string;
      after_summary: unknown;
    }>(
      `SELECT action, actor_type, actor_id, resource_type, resource_id, after_summary
       FROM audit_events WHERE tenant_id = $1 ORDER BY id`,
      [result.organization.id]
    );
    expect(events.rows.map((r) => r.action)).toEqual([
      'organization.created',
      'membership.created',
    ]);
    for (const row of events.rows) {
      expect(row.actor_type).toBe('user');
      expect(row.actor_id).toBe(userId);
    }
    expect(events.rows[0]!.resource_type).toBe('organization');
    expect(events.rows[0]!.resource_id).toBe(result.organization.id);
    expect(events.rows[1]!.resource_type).toBe('membership');
    expect(events.rows[1]!.resource_id).toBe(result.membership.id);
    // Sin email/password/token/secretos en los resumenes.
    const serialized = JSON.stringify(events.rows.map((r) => r.after_summary));
    expect(serialized).not.toContain('@example.com');
    expect(serialized).not.toMatch(/password|token|secret/i);
  });

  it('validates and normalizes the payload (trim del nombre, slug estricto)', async () => {
    const userId = await createUser();
    const slug = uniqueSlug();
    const result = await createOrganizationForUser(
      ctx.admin,
      { userId, organizationName: '  Trimmed Org  ', slug },
      audit(userId)
    );
    expect(result.organization.name).toBe('Trimmed Org');

    await expect(
      createOrganizationForUser(
        ctx.admin,
        { userId: await createUser(), organizationName: 'Valid Name', slug: 'Bad_Slug!' },
        audit(userId)
      )
    ).rejects.toThrow();
    await expect(
      createOrganizationForUser(
        ctx.admin,
        { userId: 'not-a-uuid', organizationName: 'Valid Name', slug: uniqueSlug() },
        audit(userId)
      )
    ).rejects.toThrow();
  });
});

describe('idempotencia natural (lock de la fila del usuario)', () => {
  it('two concurrent requests with the SAME payload: one org, one membership, zero duplicate audits', async () => {
    const userId = await createUser();
    const payload = { userId, organizationName: 'Concurrente SA', slug: uniqueSlug() };
    const [a, b] = await Promise.all([
      createOrganizationForUser(ctx.admin, payload, audit(userId)),
      createOrganizationForUser(ctx.admin, payload, audit(userId)),
    ]);
    expect(a.organization.id).toBe(b.organization.id);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(await ownedOrgCount(userId)).toBe(1);
    expect(await auditActions(a.organization.id)).toEqual([
      'organization.created',
      'membership.created',
    ]);
  });

  it('retry AFTER commit with the same payload: natural replay, same org, zero new rows/audits', async () => {
    const userId = await createUser();
    const payload = { userId, organizationName: 'Replay SA', slug: uniqueSlug() };
    const first = await createOrganizationForUser(ctx.admin, payload, audit(userId));
    const second = await createOrganizationForUser(ctx.admin, payload, audit(userId));
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.organization.id).toBe(first.organization.id);
    expect(second.membership.id).toBe(first.membership.id);
    expect(await ownedOrgCount(userId)).toBe(1);
    expect(await auditActions(first.organization.id)).toEqual([
      'organization.created',
      'membership.created',
    ]);
  });

  it('a DIFFERENT payload after an owner org exists => OnboardingAlreadyCompletedError, no new org', async () => {
    const userId = await createUser();
    await createOrganizationForUser(
      ctx.admin,
      { userId, organizationName: 'Primera SA', slug: uniqueSlug() },
      audit(userId)
    );
    await expect(
      createOrganizationForUser(
        ctx.admin,
        { userId, organizationName: 'Otra SA', slug: uniqueSlug() },
        audit(userId)
      )
    ).rejects.toThrow(OnboardingAlreadyCompletedError);
    expect(await ownedOrgCount(userId)).toBe(1);
  });

  it("someone else's slug => OrganizationSlugTakenError, full rollback, no foreign data leaked", async () => {
    const slug = uniqueSlug();
    const otherUser = await createUser();
    await createOrganizationForUser(
      ctx.admin,
      { userId: otherUser, organizationName: 'Dueña Del Slug', slug },
      audit(otherUser)
    );

    const userId = await createUser();
    const err = await createOrganizationForUser(
      ctx.admin,
      { userId, organizationName: 'Aspirante SA', slug },
      audit(userId)
    ).then(
      () => null,
      (e: unknown) => e as Error
    );
    expect(err).toBeInstanceOf(OrganizationSlugTakenError);
    // El error no filtra datos de la organizacion ajena (solo el slug propio).
    expect(err!.message).not.toContain('Dueña Del Slug');
    expect(await ownedOrgCount(userId)).toBe(0);
  });
});

describe('elegibilidad del usuario (verificado dentro de la transaccion)', () => {
  it('unverified user => rejection with ZERO writes', async () => {
    const userId = await createUser({ verified: false });
    await expect(
      createOrganizationForUser(
        ctx.admin,
        { userId, organizationName: 'No Verificada', slug: uniqueSlug() },
        audit(userId)
      )
    ).rejects.toThrow(OnboardingEmailNotVerifiedError);
    expect(await ownedOrgCount(userId)).toBe(0);
    const audits = await ctx.admin.query('SELECT 1 FROM audit_events WHERE actor_id = $1', [
      userId,
    ]);
    expect(audits.rowCount).toBe(0);
  });

  it('nonexistent or deleted user => safe rejection', async () => {
    await expect(
      createOrganizationForUser(
        ctx.admin,
        { userId: randomUUID(), organizationName: 'Fantasma SA', slug: uniqueSlug() },
        audit(randomUUID())
      )
    ).rejects.toThrow(OnboardingUserNotFoundError);

    const deleted = await createUser({ deleted: true });
    await expect(
      createOrganizationForUser(
        ctx.admin,
        { userId: deleted, organizationName: 'Eliminada SA', slug: uniqueSlug() },
        audit(deleted)
      )
    ).rejects.toThrow(OnboardingUserNotFoundError);
  });
});
