import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '@fluvia/db/testing';
import {
  CAPABILITY_CEILING,
  CAPABILITY_KEYS,
  CapabilityFourEyesError,
  CapabilityRequestError,
  CapabilityService,
  CapabilityUnavailableError,
  effectiveCapability,
  marketCapabilities,
} from '../src/index.js';

describe('catálogo (techo por mercado)', () => {
  it('ninguna capacidad está operativa en dinero real', () => {
    for (const m of Object.values(CAPABILITY_CEILING)) {
      for (const k of CAPABILITY_KEYS) expect(m[k]).not.toBe('operational');
    }
  });

  it('Venezuela: tarjetas reales, red de tarjetas y USDT no se ofrecen', () => {
    expect(effectiveCapability('VE', 'card.network_acceptance').offered).toBe(false);
    expect(effectiveCapability('VE', 'wallet.usdt').offered).toBe(false);
    expect(effectiveCapability('VE', 'pos.terminal').status).toBe('pending_provider');
    const wallet = effectiveCapability('VE', 'pay.wallet');
    expect(wallet).toMatchObject({ offered: true, simulated: true, status: 'sandbox' });
    expect(wallet.liveDependency).toMatch(/licencia/);
  });

  it('mercado desconocido: nada se ofrece (cerrado por defecto)', () => {
    expect(marketCapabilities('AR').every((c) => !c.offered)).toBe(true);
  });

  it('una retirada baja la capacidad a «no ofrecida» y no sube una no ofrecida', () => {
    const w = [
      {
        market: 'VE' as const,
        capability: 'pay.installments' as const,
        reason: 'x',
        withdrawnAt: 'now',
      },
      {
        market: 'VE' as const,
        capability: 'wallet.usdt' as const,
        reason: 'x',
        withdrawnAt: 'now',
      },
    ];
    expect(effectiveCapability('VE', 'pay.installments', w)).toMatchObject({
      status: 'not_offered',
      ceiling: 'sandbox',
      offered: false,
      withdrawn: { reason: 'x' },
    });
    expect(effectiveCapability('VE', 'wallet.usdt', w).status).toBe('not_offered');
    expect(effectiveCapability('CO', 'pay.installments', w).status).toBe('not_offered');
  });
});

describe('retiradas de Operaciones (PostgreSQL real)', () => {
  let ctx: TestContext;
  let program: string;
  let svc: CapabilityService;
  const alice = randomUUID();
  const bob = randomUUID();

  beforeAll(async () => {
    ctx = await createTestContext();
    program = await ctx.createTenant('programa capacidades');
    svc = new CapabilityService(ctx.app, program);
  }, 30_000);
  afterAll(() => ctx.close());

  it('retirar es idempotente; levantar exige otra persona (servicio y motor)', async () => {
    const w1 = await svc.withdraw(program, {
      market: 'VE',
      capability: 'pay.installments',
      reason: 'Incidencia del financiador',
      userId: alice,
    });
    const w2 = await svc.withdraw(program, {
      market: 'VE',
      capability: 'pay.installments',
      reason: 'otra vez',
      userId: bob,
    });
    expect(w2.id).toBe(w1.id);
    await expect(svc.require('VE', 'pay.installments')).rejects.toBeInstanceOf(
      CapabilityUnavailableError
    );
    await expect(
      svc.restore(program, { id: w1.id, reason: 'Ya resuelto', userId: alice })
    ).rejects.toBeInstanceOf(CapabilityFourEyesError);
    // El motor también lo impide aunque el servicio fallara.
    await expect(
      ctx.admin.query(
        `UPDATE capability_withdrawals SET lifted_by_user_id = withdrawn_by_user_id,
                lifted_at = now(), lift_reason = 'saltarse los cuatro ojos' WHERE id = $1`,
        [w1.id]
      )
    ).rejects.toThrow(/four_eyes/);
    const r = await svc.restore(program, {
      id: w1.id,
      reason: 'Financiador restablecido',
      userId: bob,
    });
    expect(r.liftedByUserId).toBe(bob);
    expect((await svc.require('VE', 'pay.installments')).offered).toBe(true);
    // Una retirada levantada es historia: no se reescribe ni se borra.
    await expect(
      ctx.admin.query(`UPDATE capability_withdrawals SET lift_reason = 'cambio' WHERE id = $1`, [
        w1.id,
      ])
    ).rejects.toThrow(/already lifted/);
    await expect(
      ctx.admin.query(`DELETE FROM capability_withdrawals WHERE id = $1`, [w1.id])
    ).rejects.toThrow();
  });

  it('no se retira lo que no se ofrece ni capacidades o mercados desconocidos', async () => {
    for (const input of [
      { market: 'VE', capability: 'wallet.usdt' },
      { market: 'AR', capability: 'pay.wallet' },
      { market: 'VE', capability: 'pay.bitcoin' },
    ]) {
      await expect(
        svc.withdraw(program, { ...input, reason: 'prueba de rechazo', userId: alice })
      ).rejects.toBeInstanceOf(CapabilityRequestError);
    }
  });

  it('las retiradas de un programa no afectan a otro tenant (RLS)', async () => {
    const other = await ctx.createTenant('otro programa');
    await svc.withdraw(program, {
      market: 'VE',
      capability: 'pos.tap_to_pay',
      reason: 'Pausa del simulador',
      userId: alice,
    });
    expect((await new CapabilityService(ctx.app, other).get('VE', 'pos.tap_to_pay')).offered).toBe(
      true
    );
    expect((await svc.history(other)).length).toBe(0);
  });
});
