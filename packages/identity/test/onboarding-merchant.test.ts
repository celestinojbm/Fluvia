import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditContext } from '@fluvia/audit';
import { createTestContext, type TestContext } from '@fluvia/db/testing';
import {
  IdentityService,
  MerchantNameTakenError,
  MerchantOnboardingAlreadyCompletedError,
  merchantCreationLockKey,
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

describe('advisory lock transaccional por tenant (compartido por creacion general y onboarding)', () => {
  /**
   * Deteccion DETERMINISTA de bloqueo/orden via pg_locks (sin sleeps como
   * prueba): un waiter del advisory lock aparece como fila `NOT granted` con
   * classid/objid = mitades del bigint de la clave. El poll es solo espera
   * acotada; la PRUEBA es la fila del lock manager y el orden FIFO con el que
   * PostgreSQL concede el lock a los waiters encolados.
   */
  async function advisoryWaiterCount(key: string): Promise<number> {
    const u = BigInt.asUintN(64, BigInt(key));
    const classid = (u >> 32n).toString();
    const objid = (u & 0xffffffffn).toString();
    const res = await ctx.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_locks
       WHERE locktype = 'advisory' AND classid = $1::oid AND objid = $2::oid
         AND objsubid = 1 AND NOT granted`,
      [classid, objid]
    );
    return Number(res.rows[0]!.n);
  }

  async function waitForAdvisoryWaiters(key: string, expected: number): Promise<void> {
    for (let i = 0; i < 400; i++) {
      if ((await advisoryWaiterCount(key)) >= expected) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`advisory waiters never reached ${expected}`);
  }

  /**
   * Harness de ORDEN CONTROLADO: un gate (tx admin) retiene el lock del
   * tenant; `first` se encola (1 waiter verificado en pg_locks), luego
   * `second` (2 waiters). Al COMMIT del gate, PostgreSQL concede FIFO:
   * `first` adquiere el lock ANTES que `second` — orden total determinista
   * sin sleeps como prueba.
   */
  async function withGatedOrder(
    tenantId: string,
    first: () => Promise<unknown>,
    second: () => Promise<unknown>
  ): Promise<[PromiseSettledResult<unknown>, PromiseSettledResult<unknown>]> {
    const key = await merchantCreationLockKey(ctx.admin, tenantId);
    const gate = await ctx.admin.connect();
    try {
      await gate.query('BEGIN');
      await gate.query('SELECT pg_advisory_xact_lock($1::bigint)', [key]);
      const p1 = first();
      await waitForAdvisoryWaiters(key, 1);
      const p2 = second();
      await waitForAdvisoryWaiters(key, 2);
      // Ambas operaciones estan BLOQUEADAS en el lock (antes de contar o
      // insertar): mientras el gate vive, ninguna toco la tabla.
      await gate.query('COMMIT');
      return (await Promise.allSettled([p1, p2])) as [
        PromiseSettledResult<unknown>,
        PromiseSettledResult<unknown>,
      ];
    } finally {
      gate.release();
    }
  }

  it('the key is computed IN PostgreSQL (bigint as text — no JS precision loss), stable and per-tenant', async () => {
    const a = await ctx.createTenant();
    const b = await ctx.createTenant();
    const keyA1 = await merchantCreationLockKey(ctx.admin, a);
    const keyA2 = await merchantCreationLockKey(ctx.admin, a);
    const keyB = await merchantCreationLockKey(ctx.admin, b);
    // bigint serializado como texto: puede exceder Number.MAX_SAFE_INTEGER.
    expect(keyA1).toMatch(/^-?\d+$/);
    expect(BigInt(keyA1).toString()).toBe(keyA1);
    expect(keyA2).toBe(keyA1); // estable
    expect(keyB).not.toBe(keyA1); // namespaced por tenant
  });

  it('onboarding takes the lock BEFORE counting: a held lock shows a pg_locks waiter and zero rows', async () => {
    const tenantId = await ctx.createTenant();
    const key = await merchantCreationLockKey(ctx.admin, tenantId);
    const holder = await ctx.admin.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock($1::bigint)', [key]);
      const pending = service.ensureMerchantForOnboarding(tenantId, { name: 'Bloqueada' }, audit());
      // Prueba determinista de bloqueo: waiter NOT granted en pg_locks, y la
      // tabla sigue vacia (el lock va ANTES del conteo y del insert).
      await waitForAdvisoryWaiters(key, 1);
      expect(await merchantCount(tenantId)).toBe(0);
      await holder.query('COMMIT');
      const result = await pending;
      expect(result.replayed).toBe(false);
      expect(await merchantCount(tenantId)).toBe(1);
    } finally {
      holder.release();
    }
  });

  it('the GENERAL createMerchant also takes the SAME lock before inserting (shared key)', async () => {
    const tenantId = await ctx.createTenant();
    const key = await merchantCreationLockKey(ctx.admin, tenantId);
    const holder = await ctx.admin.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock($1::bigint)', [key]);
      const pending = service.createMerchant(tenantId, { name: 'General Bloqueada' }, audit());
      await waitForAdvisoryWaiters(key, 1);
      expect(await merchantCount(tenantId)).toBe(0);
      await holder.query('COMMIT');
      await expect(pending).resolves.toBeTruthy();
      expect(await merchantCount(tenantId)).toBe(1);
    } finally {
      holder.release();
    }
  });

  it('DIFFERENT tenants do not block each other globally (neither path)', async () => {
    const a = await ctx.createTenant();
    const b = await ctx.createTenant();
    const keyA = await merchantCreationLockKey(ctx.admin, a);
    const holder = await ctx.admin.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock($1::bigint)', [keyA]);
      // Con el lock de A retenido, AMBOS caminos de B completan sin esperar.
      const onboarding = await service.ensureMerchantForOnboarding(
        b,
        { name: 'Tienda B' },
        audit()
      );
      expect(onboarding.replayed).toBe(false);
      await expect(service.createMerchant(b, { name: 'Tienda B2' }, audit())).resolves.toBeTruthy();
      await holder.query('ROLLBACK');
    } finally {
      holder.release();
    }
  });

  it('the lock does NOT depend on the merchant name and is released on commit AND rollback (both paths)', async () => {
    const tenantId = await ctx.createTenant();
    const key = await merchantCreationLockKey(ctx.admin, tenantId);
    const probeFree = async () => {
      const probe = await ctx.admin.connect();
      try {
        await probe.query('BEGIN');
        const free = await probe.query<{ ok: boolean }>(
          'SELECT pg_try_advisory_xact_lock($1::bigint) AS ok',
          [key]
        );
        await probe.query('ROLLBACK');
        return free.rows[0]!.ok;
      } finally {
        probe.release();
      }
    };

    // COMMIT del onboarding libera el lock.
    await service.ensureMerchantForOnboarding(tenantId, { name: 'Primera' }, audit());
    expect(await probeFree()).toBe(true);
    // ROLLBACK del onboarding (payload distinto => 409, con OTRO nombre)
    // tambien libera: la clave es por tenant, no por nombre.
    await expect(
      service.ensureMerchantForOnboarding(tenantId, { name: 'Distinta' }, audit())
    ).rejects.toThrow(MerchantOnboardingAlreadyCompletedError);
    expect(await probeFree()).toBe(true);
    // COMMIT del camino general libera.
    await service.createMerchant(tenantId, { name: 'Adicional' }, audit());
    expect(await probeFree()).toBe(true);
    // ROLLBACK del camino general (nombre duplicado) tambien libera.
    await expect(service.createMerchant(tenantId, { name: 'Adicional' }, audit())).rejects.toThrow(
      MerchantNameTakenError
    );
    expect(await probeFree()).toBe(true);
  });

  // ── RA-F65C2-EXT-001: serializacion COMPARTIDA general ↔ onboarding ────────
  // Orden controlado por el gate + FIFO del lock manager (pg_locks probado en
  // cada paso); se ejercitan AMBOS ordenes de adquisicion/finalizacion.

  it('[general primero] onboarding con el MISMO payload espera y devuelve replay: una fila, un audit', async () => {
    const tenantId = await ctx.createTenant();
    const payload = { name: 'Compartida', country: 'CO', defaultCurrency: 'COP' as const };
    const [general, onboarding] = await withGatedOrder(
      tenantId,
      () => service.createMerchant(tenantId, payload, audit()),
      () => service.ensureMerchantForOnboarding(tenantId, payload, audit())
    );
    expect(general.status).toBe('fulfilled');
    expect(onboarding.status).toBe('fulfilled');
    const created = (general as PromiseFulfilledResult<{ id: string }>).value;
    const replayed = (
      onboarding as PromiseFulfilledResult<{ merchant: { id: string }; replayed: boolean }>
    ).value;
    // El onboarding observo EXACTAMENTE el merchant creado por la general.
    expect(replayed.replayed).toBe(true);
    expect(replayed.merchant.id).toBe(created.id);
    expect(await merchantCount(tenantId)).toBe(1);
    expect(await merchantAuditCount(tenantId)).toBe(1);
  });

  for (const [label, generalPayload, onboardingPayload] of [
    ['nombre distinto', { name: 'General Gana' }, { name: 'Onboarding Pierde' }],
    ['solo country distinto', { name: 'Mismo Nombre' }, { name: 'Mismo Nombre', country: 'MX' }],
    [
      'solo defaultCurrency distinto',
      { name: 'Mismo Nombre' },
      { name: 'Mismo Nombre', defaultCurrency: 'USD' as const },
    ],
  ] as const) {
    it(`[general primero] payload que difiere (${label}): onboarding espera y recibe 409; una fila`, async () => {
      const tenantId = await ctx.createTenant();
      const [general, onboarding] = await withGatedOrder(
        tenantId,
        () => service.createMerchant(tenantId, generalPayload, audit()),
        () => service.ensureMerchantForOnboarding(tenantId, onboardingPayload, audit())
      );
      expect(general.status).toBe('fulfilled');
      expect(onboarding.status).toBe('rejected');
      expect((onboarding as PromiseRejectedResult).reason).toBeInstanceOf(
        MerchantOnboardingAlreadyCompletedError
      );
      expect(await merchantCount(tenantId)).toBe(1);
      expect(await merchantAuditCount(tenantId)).toBe(1);
    });
  }

  it('[onboarding primero] la general espera y crea un merchant ADICIONAL: dos filas, un audit por merchant', async () => {
    const tenantId = await ctx.createTenant();
    const [onboarding, general] = await withGatedOrder(
      tenantId,
      () => service.ensureMerchantForOnboarding(tenantId, { name: 'Inicial' }, audit()),
      () => service.createMerchant(tenantId, { name: 'Adicional Post' }, audit())
    );
    // Orden inverso de finalizacion respecto a los tests anteriores: el
    // onboarding ADQUIERE y COMMITEA primero; la creacion general queda
    // logicamente DESPUES del merchant inicial (valido por contrato).
    expect(onboarding.status).toBe('fulfilled');
    expect(general.status).toBe('fulfilled');
    const initial = (
      onboarding as PromiseFulfilledResult<{ merchant: { id: string }; replayed: boolean }>
    ).value;
    expect(initial.replayed).toBe(false);
    const additional = (general as PromiseFulfilledResult<{ id: string }>).value;
    expect(additional.id).not.toBe(initial.merchant.id);
    expect(await merchantCount(tenantId)).toBe(2);
    // Exactamente UN audit merchant.created por cada merchant.
    const perMerchant = await ctx.admin.query<{ resource_id: string; n: string }>(
      `SELECT resource_id, count(*)::text AS n FROM audit_events
       WHERE tenant_id = $1 AND action = 'merchant.created' GROUP BY resource_id`,
      [tenantId]
    );
    expect(perMerchant.rows).toHaveLength(2);
    for (const row of perMerchant.rows) expect(row.n).toBe('1');
  });

  it('[onboarding primero] la general con el MISMO nombre espera y termina en MerchantNameTakenError: una fila', async () => {
    const tenantId = await ctx.createTenant();
    const [onboarding, general] = await withGatedOrder(
      tenantId,
      () => service.ensureMerchantForOnboarding(tenantId, { name: 'Unica' }, audit()),
      () => service.createMerchant(tenantId, { name: 'Unica' }, audit())
    );
    expect(onboarding.status).toBe('fulfilled');
    expect(general.status).toBe('rejected');
    expect((general as PromiseRejectedResult).reason).toBeInstanceOf(MerchantNameTakenError);
    expect(await merchantCount(tenantId)).toBe(1);
    expect(await merchantAuditCount(tenantId)).toBe(1);
  });
});
