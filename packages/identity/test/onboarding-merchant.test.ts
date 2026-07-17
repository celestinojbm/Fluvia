import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditContext } from '@fluvia/audit';
import { createTestContext, type TestContext } from '@fluvia/db/testing';
import {
  IdentityService,
  MerchantOnboardingAlreadyCompletedError,
  merchantOnboardingLockKey,
} from '../src/index.js';

/**
 * F6.5C2 Paso B — `ensureMerchantForOnboarding` contra PostgreSQL real:
 * cardinalidad UNO por organizacion serializada por advisory lock
 * transaccional por tenant (independiente del nombre), replay natural con
 * payload identico, 409 con payload distinto o >1 merchants, auditoria
 * `merchant.created` exactamente una vez.
 */

let ctx: TestContext;
let service: IdentityService;

const audit = (requestId = randomUUID()): AuditContext => ({
  actorType: 'user',
  actorId: randomUUID(),
  authMethod: 'session',
  requestId,
});

async function merchantCount(tenantId: string): Promise<number> {
  const res = await ctx.admin.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM merchants WHERE tenant_id = $1 AND deleted_at IS NULL',
    [tenantId]
  );
  return Number(res.rows[0]!.n);
}

async function merchantAuditCount(tenantId: string): Promise<number> {
  const res = await ctx.admin.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audit_events
     WHERE tenant_id = $1 AND action = 'merchant.created'`,
    [tenantId]
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

describe('contrato bajo el lock', () => {
  it('first call creates ONE merchant with Colombia defaults and audits merchant.created once', async () => {
    const tenantId = await ctx.createTenant();
    const result = await service.ensureMerchantForOnboarding(
      tenantId,
      { name: 'Tienda Onboarding' },
      audit()
    );
    expect(result.replayed).toBe(false);
    expect(result.merchant.country).toBe('CO');
    expect(result.merchant.defaultCurrency).toBe('COP');
    expect(await merchantCount(tenantId)).toBe(1);
    expect(await merchantAuditCount(tenantId)).toBe(1);
  });

  it('identical payload after commit: returns the existing merchant, replay natural, zero duplicate audit', async () => {
    const tenantId = await ctx.createTenant();
    const first = await service.ensureMerchantForOnboarding(
      tenantId,
      { name: 'Tienda Replay', country: 'CO', defaultCurrency: 'COP' },
      audit()
    );
    const second = await service.ensureMerchantForOnboarding(
      tenantId,
      { name: 'Tienda Replay', country: 'CO', defaultCurrency: 'COP' },
      audit()
    );
    expect(second.replayed).toBe(true);
    expect(second.merchant.id).toBe(first.merchant.id);
    expect(await merchantCount(tenantId)).toBe(1);
    expect(await merchantAuditCount(tenantId)).toBe(1);
  });

  it('a DIFFERENT payload (any contractual field) => MerchantOnboardingAlreadyCompletedError', async () => {
    const tenantId = await ctx.createTenant();
    await service.ensureMerchantForOnboarding(tenantId, { name: 'Tienda Base' }, audit());
    for (const payload of [
      { name: 'Otra Tienda' },
      { name: 'Tienda Base', country: 'MX' },
      { name: 'Tienda Base', defaultCurrency: 'USD' as const },
    ]) {
      await expect(service.ensureMerchantForOnboarding(tenantId, payload, audit())).rejects.toThrow(
        MerchantOnboardingAlreadyCompletedError
      );
    }
    expect(await merchantCount(tenantId)).toBe(1);
  });

  it('two or more preexisting merchants => stable 409, NEVER an arbitrary pick (even with a matching name)', async () => {
    const tenantId = await ctx.createTenant();
    await service.createMerchant(tenantId, { name: 'Comercio Uno' });
    await service.createMerchant(tenantId, { name: 'Comercio Dos' });
    await expect(
      service.ensureMerchantForOnboarding(tenantId, { name: 'Comercio Uno' }, audit())
    ).rejects.toThrow(MerchantOnboardingAlreadyCompletedError);
    expect(await merchantCount(tenantId)).toBe(2);
  });

  it('does not alter the general createMerchant contract (still throws MerchantNameTakenError)', async () => {
    const tenantId = await ctx.createTenant();
    await service.ensureMerchantForOnboarding(tenantId, { name: 'Onboarding Store' }, audit());
    await expect(service.createMerchant(tenantId, { name: 'Onboarding Store' })).rejects.toThrow(
      /already exists/
    );
    await expect(
      service.createMerchant(tenantId, { name: 'Segunda Tienda' })
    ).resolves.toBeTruthy();
  });
});

describe('concurrencia (la garantia que UNIQUE(tenant_id,name) NO da)', () => {
  it('two concurrent requests with the SAME payload: one merchant, zero duplicate audits', async () => {
    const tenantId = await ctx.createTenant();
    const payload = { name: 'Concurrente Igual' };
    const results = await Promise.all([
      service.ensureMerchantForOnboarding(tenantId, payload, audit()),
      service.ensureMerchantForOnboarding(tenantId, payload, audit()),
    ]);
    expect(results[0]!.merchant.id).toBe(results[1]!.merchant.id);
    expect(results.map((r) => r.replayed).sort()).toEqual([false, true]);
    expect(await merchantCount(tenantId)).toBe(1);
    expect(await merchantAuditCount(tenantId)).toBe(1);
  });

  it('two concurrent requests with DIFFERENT names: ONE merchant row, one wins, the other gets the 409', async () => {
    const tenantId = await ctx.createTenant();
    const settled = await Promise.allSettled([
      service.ensureMerchantForOnboarding(tenantId, { name: 'Nombre Alfa' }, audit()),
      service.ensureMerchantForOnboarding(tenantId, { name: 'Nombre Beta' }, audit()),
    ]);
    const fulfilled = settled.filter((s) => s.status === 'fulfilled');
    const rejected = settled.filter((s) => s.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      MerchantOnboardingAlreadyCompletedError
    );
    expect(await merchantCount(tenantId)).toBe(1);
    expect(await merchantAuditCount(tenantId)).toBe(1);
  });
});

describe('advisory lock transaccional por tenant', () => {
  it('the key is computed IN PostgreSQL (bigint as text — no JS precision loss), stable and per-tenant', async () => {
    const a = await ctx.createTenant();
    const b = await ctx.createTenant();
    const keyA1 = await merchantOnboardingLockKey(ctx.admin, a);
    const keyA2 = await merchantOnboardingLockKey(ctx.admin, a);
    const keyB = await merchantOnboardingLockKey(ctx.admin, b);
    // bigint serializado como texto: puede exceder Number.MAX_SAFE_INTEGER.
    expect(keyA1).toMatch(/^-?\d+$/);
    expect(BigInt(keyA1).toString()).toBe(keyA1);
    expect(keyA2).toBe(keyA1); // estable
    expect(keyB).not.toBe(keyA1); // namespaced por tenant
  });

  it('the lock is taken BEFORE counting: a held lock blocks the whole operation for the SAME tenant', async () => {
    const tenantId = await ctx.createTenant();
    const key = await merchantOnboardingLockKey(ctx.admin, tenantId);

    const holder = await ctx.admin.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock($1::bigint)', [key]);

      let done = false;
      const pending = service
        .ensureMerchantForOnboarding(tenantId, { name: 'Bloqueada' }, audit())
        .then((r) => {
          done = true;
          return r;
        });
      await new Promise((r) => setTimeout(r, 300));
      // Bloqueado ANTES de contar/insertar: cero merchants mientras el lock vive.
      expect(done).toBe(false);
      expect(await merchantCount(tenantId)).toBe(0);

      await holder.query('COMMIT'); // libera el lock (transaccional)
      const result = await pending;
      expect(done).toBe(true);
      expect(result.replayed).toBe(false);
      expect(await merchantCount(tenantId)).toBe(1);
    } finally {
      holder.release();
    }
  });

  it('DIFFERENT tenants do not block each other globally', async () => {
    const a = await ctx.createTenant();
    const b = await ctx.createTenant();
    const keyA = await merchantOnboardingLockKey(ctx.admin, a);

    const holder = await ctx.admin.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock($1::bigint)', [keyA]);
      // Con el lock de A retenido, el onboarding de B completa sin esperar.
      const result = await service.ensureMerchantForOnboarding(b, { name: 'Tienda B' }, audit());
      expect(result.replayed).toBe(false);
      await holder.query('ROLLBACK');
    } finally {
      holder.release();
    }
  });

  it('the lock does NOT depend on the merchant name and is released on commit AND rollback', async () => {
    const tenantId = await ctx.createTenant();
    const key = await merchantOnboardingLockKey(ctx.admin, tenantId);

    // Tras un COMMIT (creacion exitosa) el lock quedo libre.
    await service.ensureMerchantForOnboarding(tenantId, { name: 'Primera' }, audit());
    const probe = await ctx.admin.connect();
    try {
      await probe.query('BEGIN');
      const free = await probe.query<{ ok: boolean }>(
        'SELECT pg_try_advisory_xact_lock($1::bigint) AS ok',
        [key]
      );
      expect(free.rows[0]!.ok).toBe(true);
      await probe.query('ROLLBACK');

      // Tras un ROLLBACK (payload distinto => 409, con OTRO nombre) tambien:
      // la clave es por tenant, no por nombre.
      await expect(
        service.ensureMerchantForOnboarding(tenantId, { name: 'Distinta' }, audit())
      ).rejects.toThrow(MerchantOnboardingAlreadyCompletedError);
      await probe.query('BEGIN');
      const freeAgain = await probe.query<{ ok: boolean }>(
        'SELECT pg_try_advisory_xact_lock($1::bigint) AS ok',
        [key]
      );
      expect(freeAgain.rows[0]!.ok).toBe(true);
      await probe.query('ROLLBACK');
    } finally {
      probe.release();
    }
  });
});
