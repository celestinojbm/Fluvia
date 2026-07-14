import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenantTransaction } from '@fluvia/db';
import { createTestContext, type TestContext } from '@fluvia/db/testing';
import { AuditReader, insertAuditEvent, redactSummary } from '../src/index.js';

let ctx: TestContext;
let reader: AuditReader;
let orgA: string;
let orgB: string;

beforeAll(async () => {
  ctx = await createTestContext();
  reader = new AuditReader(ctx.app);
  orgA = await ctx.createTenant();
  orgB = await ctx.createTenant();
}, 30_000);

afterAll(async () => {
  await ctx.close();
});

describe('redactSummary', () => {
  it('redacts sensitive keys recursively and preserves the rest', () => {
    expect(
      redactSummary({
        name: 'ok',
        secret: 'x',
        nested: { api_token: 'y', password: 'z', label: 'fine' },
        list: [{ key_hash: 'h' }],
      })
    ).toEqual({
      name: 'ok',
      secret: '[REDACTED]',
      nested: { api_token: '[REDACTED]', password: '[REDACTED]', label: 'fine' },
      list: [{ key_hash: '[REDACTED]' }],
    });
  });

  // RA-F65B-EXT-001: los secretos EMBEBIDOS en strings (URLs con query/userinfo/
  // fragment o token opaco en el PATH) no los ve la redacción por nombre de
  // clave — se redactan aparte. El path se redacta ENTERO.
  it('redacts credential-bearing URL parts (including the whole PATH) embedded inside string values', () => {
    expect(
      redactSummary({
        url: 'https://example.test/hook?token=SECRETVALUE',
        note: 'destino https://u:p@example.test/x#frag registrado',
        bare: 'https://example.test',
        plain: 'sin url aquí',
      })
    ).toEqual({
      url: 'https://example.test/[REDACTED_PATH]?[REDACTED]',
      note: 'destino https://[REDACTED]@example.test/[REDACTED_PATH]#[REDACTED] registrado',
      bare: 'https://example.test',
      plain: 'sin url aquí',
    });
    // Token opaco SOLO en el path: eliminado; la forma redactada tampoco
    // contiene query, fragment ni userinfo.
    const redacted = JSON.stringify(
      redactSummary({
        note: 'endpoint https://hooks.example.test/services/EXT1_PATH_SECRET_DO_NOT_LEAK creado',
      })
    );
    expect(redacted).not.toContain('EXT1_PATH_SECRET_DO_NOT_LEAK');
    expect(redacted).toContain('https://hooks.example.test/[REDACTED_PATH]');
    const blob = JSON.stringify(
      redactSummary({ after: { u: 'postgres://user:pass@db.internal/x?sslmode=1' } })
    );
    expect(blob).not.toContain('pass');
    expect(blob).not.toContain('sslmode');
    expect(blob).not.toContain('/x');
  });
});

describe('audit_events bajo RLS (F1-05)', () => {
  it('tenant-plane insert within the action transaction, isolated per tenant', async () => {
    await withTenantTransaction(ctx.app, orgA, (c) =>
      insertAuditEvent(c, {
        action: 'merchant.created',
        tenantId: orgA,
        context: { actorType: 'user', requestId: 'req-1' },
        resourceType: 'merchant',
        resourceId: 'm-1',
        after: { name: 'Tienda', secret: 'should-hide' },
      })
    );
    const eventsA = await reader.list(orgA);
    expect(eventsA.some((e) => e.action === 'merchant.created')).toBe(true);
    const eventsB = await reader.list(orgB);
    expect(eventsB.some((e) => e.resourceId === 'm-1')).toBe(false);

    const raw = await ctx.admin.query<{ after_summary: { secret: string } }>(
      "SELECT after_summary FROM audit_events WHERE resource_id = 'm-1'"
    );
    expect(raw.rows[0]!.after_summary.secret).toBe('[REDACTED]');
  });

  it('auth-plane (fluvia_auth) can insert ONLY tenantless events', async () => {
    await insertAuditEvent(ctx.auth, {
      action: 'auth.login_failed',
      context: { actorType: 'user', authMethod: 'none' },
      result: 'failure',
      riskLevel: 'medium',
    });
    await expect(
      insertAuditEvent(ctx.auth, {
        action: 'auth.login_failed',
        tenantId: orgA,
        context: { actorType: 'user' },
      })
    ).rejects.toThrow(/row-level security/i);
  });

  it('the app role cannot insert tenantless events nor cross-tenant events', async () => {
    await expect(
      withTenantTransaction(ctx.app, orgA, (c) =>
        insertAuditEvent(c, {
          action: 'auth.login_failed',
          tenantId: null,
          context: { actorType: 'system' },
        })
      )
    ).rejects.toThrow(/row-level security/i);
    await expect(
      withTenantTransaction(ctx.app, orgA, (c) =>
        insertAuditEvent(c, {
          action: 'merchant.created',
          tenantId: orgB,
          context: { actorType: 'user' },
        })
      )
    ).rejects.toThrow(/row-level security/i);
  });

  it('is append-only: UPDATE and DELETE fail even for admin', async () => {
    await expect(ctx.admin.query("UPDATE audit_events SET reason = 'tamper'")).rejects.toThrow(
      /FLUVIA_IMMUTABLE/
    );
    await expect(ctx.admin.query('DELETE FROM audit_events')).rejects.toThrow(/FLUVIA_IMMUTABLE/);
  });

  it('withPlatformOperation requires a reason and audits the bypass atomically', async () => {
    const { withPlatformOperation, PlatformReasonRequiredError } = await import('../src/index.js');
    await expect(
      withPlatformOperation(ctx.admin, { tenantId: orgA, reason: '  ' }, async () => 'x')
    ).rejects.toThrow(PlatformReasonRequiredError);

    const requestId = `req-platform-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const result = await withPlatformOperation(
      ctx.admin,
      { tenantId: orgA, reason: 'soporte: investigacion caso #42', requestId },
      async (c) => {
        // Operacion cross-tenant legitima (plano de plataforma).
        const r = await c.query('SELECT count(*)::int AS n FROM audit_events');
        return r.rows[0].n as number;
      }
    );
    expect(result).toBeGreaterThanOrEqual(0);

    const trail = await ctx.admin.query(
      `SELECT reason, risk_level, auth_method FROM audit_events
       WHERE action = 'platform.operation' AND request_id = $1`,
      [requestId]
    );
    expect(trail.rowCount).toBe(1);
    expect(trail.rows[0]!.reason).toBe('soporte: investigacion caso #42');
    expect(trail.rows[0]!.risk_level).toBe('high');
    expect(trail.rows[0]!.auth_method).toBe('platform');
  });

  it('withPlatformOperation rolls back BOTH the operation and its audit trail on failure', async () => {
    const { withPlatformOperation } = await import('../src/index.js');
    await expect(
      withPlatformOperation(
        ctx.admin,
        { tenantId: orgA, reason: 'will fail', requestId: 'req-platform-fail' },
        async () => {
          throw new Error('boom');
        }
      )
    ).rejects.toThrow('boom');
    const trail = await ctx.admin.query(
      "SELECT 1 FROM audit_events WHERE request_id = 'req-platform-fail'"
    );
    expect(trail.rowCount).toBe(0);
  });

  it('paginates descending with the before cursor', async () => {
    for (let i = 0; i < 5; i++) {
      await withTenantTransaction(ctx.app, orgB, (c) =>
        insertAuditEvent(c, {
          action: 'merchant.updated',
          tenantId: orgB,
          context: { actorType: 'user' },
          resourceId: `page-${i}`,
        })
      );
    }
    const first = await reader.list(orgB, { limit: 2 });
    expect(first).toHaveLength(2);
    const second = await reader.list(orgB, { limit: 2, before: first[1]!.id });
    expect(second).toHaveLength(2);
    expect(Number(second[0]!.id)).toBeLessThan(Number(first[1]!.id));
  });
});
