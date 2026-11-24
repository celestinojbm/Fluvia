import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenantTransaction } from '@fluvia/db';
import { createTestContext, type TestContext } from '@fluvia/db/testing';
import { LedgerService, PostingService } from '@fluvia/ledger';
import { Money } from '@fluvia/money';
import { ZodError } from 'zod';
import {
  FLOW_SUSPENDED_SQLSTATE,
  KillSwitchAdmin,
  KillSwitchAlreadyReleasedError,
  KillSwitchNotFoundError,
  KillSwitchUnknownMerchantError,
  KillSwitchUnknownTenantError,
  MockPaymentProvider,
  PaymentConfirmationService,
  PaymentIntentService,
  PayoutService,
  ZERO_FEE_SCHEDULE,
  isFlowSuspendedDbError,
  type PaymentProvider,
} from '../src/index.js';

/**
 * #91 — kill switch por país o contraparte, contra PG real.
 *
 * El corte lo hace el MOTOR (0068): se prueba por los servicios reales (no por
 * un flag en memoria) que crear intents, confirmar (attempts) y emitir payouts
 * falla con SQLSTATE FV451 mientras el interruptor está activo, que lo ya en
 * vuelo se sigue resolviendo, y que liberar restaura el flujo.
 *
 * Aislamiento: los tests corren en paralelo con otros archivos sobre la MISMA
 * base, así que nunca se corta un país real ni el proveedor `mock`: se usa el
 * código ISO de uso privado `ZZ`, comercios propios y proveedores con nombre
 * único. Todo interruptor se libera al final.
 */

let ctx: TestContext;
let admin: KillSwitchAdmin;
let intents: PaymentIntentService;
let posting: PostingService;
const engaged: string[] = [];

const cop = (n: number) => Money.of(n, 'COP');
const OPS = randomUUID();
const OTHER_OPS = randomUUID();

/** Proveedor mock con nombre propio: un corte por proveedor no toca a `mock`. */
function namedProvider(name: string): PaymentProvider {
  const inner = new MockPaymentProvider();
  return {
    name,
    submitPayment: (i) => inner.submitPayment(i),
    refundPayment: (i) => inner.refundPayment(i),
    submitPayout: (i) => inner.submitPayout(i),
  };
}

beforeAll(async () => {
  ctx = await createTestContext();
  admin = new KillSwitchAdmin(ctx.admin);
  intents = new PaymentIntentService(ctx.app);
  posting = new PostingService(new LedgerService(ctx.app), ctx.app);
}, 30_000);

afterAll(async () => {
  // Nunca dejar un corte activo para otros archivos/ejecuciones.
  for (const id of engaged) {
    await admin.release({ id, reason: 'test cleanup', actorId: OPS }).catch(() => undefined);
  }
  await ctx.close();
});

async function engage(scope: 'country' | 'merchant' | 'provider' | 'tenant', target: string) {
  const res = await admin.engage({ scope, target, reason: `test ${scope}`, actorId: OPS });
  engaged.push(res.killSwitch.id);
  return res;
}

async function scenario(country = 'CO'): Promise<{ org: string; m: string }> {
  const org = await ctx.createTenant(`KS ${randomUUID().slice(0, 8)}`);
  const res = await ctx.admin.query<{ id: string }>(
    `INSERT INTO merchants (tenant_id, name, country) VALUES ($1, $2, $3) RETURNING id`,
    [org, `ks-shop-${randomUUID().slice(0, 8)}`, country]
  );
  return { org, m: res.rows[0]!.id };
}

async function expectSuspended(p: Promise<unknown>): Promise<void> {
  const err = await p.then(
    () => null,
    (e: unknown) => e
  );
  expect(err, 'expected the engine to block the flow').not.toBeNull();
  expect(isFlowSuspendedDbError(err)).toBe(true);
  expect((err as { code: string }).code).toBe(FLOW_SUSPENDED_SQLSTATE);
  // La razón del corte (posible dato sensible) no viaja en el error.
  expect((err as Error).message).not.toContain('test ');
}

const uniqueProvider = () => `ks-${randomUUID().slice(0, 8)}`;

describe('guard del motor: qué corta', () => {
  it('country: bloquea intents de comercios de ese país y no los de otro', async () => {
    const blocked = await scenario('ZZ');
    const other = await scenario('CO');
    await engage('country', 'zz'); // normaliza a ZZ

    await expectSuspended(
      intents.create({ tenantId: blocked.org, merchantId: blocked.m, amount: cop(10_000) })
    );
    const ok = await intents.create({
      tenantId: other.org,
      merchantId: other.m,
      amount: cop(10_000),
    });
    expect(ok.status).toBe('created');

    // Nada quedó a medias: ni intent ni evento de outbox del comercio bloqueado.
    const rows = await ctx.admin.query(`SELECT 1 FROM payment_intents WHERE merchant_id = $1`, [
      blocked.m,
    ]);
    expect(rows.rowCount).toBe(0);
  });

  it('merchant: confirmar un intent creado ANTES del corte falla y deja el intent intacto', async () => {
    const { org, m } = await scenario();
    const confirmation = new PaymentConfirmationService(
      ctx.app,
      intents,
      posting,
      new MockPaymentProvider(),
      ZERO_FEE_SCHEDULE
    );
    const intent = await intents.create({ tenantId: org, merchantId: m, amount: cop(20_000) });
    await engage('merchant', m.toUpperCase()); // normaliza a minúsculas

    await expectSuspended(
      withTenantTransaction(ctx.app, org, (c) => confirmation.beginIn(c, org, intent.id))
    );
    // Atómico: la transición a processing se revirtió con el attempt.
    expect((await intents.get(org, intent.id)).status).toBe('created');
    const attempts = await ctx.admin.query(`SELECT 1 FROM payment_attempts WHERE intent_id = $1`, [
      intent.id,
    ]);
    expect(attempts.rowCount).toBe(0);
  });

  it('provider: bloquea attempts y payouts de ese proveedor, no los de otro', async () => {
    const { org, m } = await scenario();
    const name = uniqueProvider();
    const blockedConfirm = new PaymentConfirmationService(
      ctx.app,
      intents,
      posting,
      namedProvider(name),
      ZERO_FEE_SCHEDULE
    );
    const otherConfirm = new PaymentConfirmationService(
      ctx.app,
      intents,
      posting,
      namedProvider(uniqueProvider()),
      ZERO_FEE_SCHEDULE
    );
    await engage('provider', name);

    // Crear el intent NO depende del proveedor: sigue permitido.
    const i1 = await intents.create({ tenantId: org, merchantId: m, amount: cop(5_000) });
    await expectSuspended(
      withTenantTransaction(ctx.app, org, (c) => blockedConfirm.beginIn(c, org, i1.id))
    );
    const i2 = await intents.create({ tenantId: org, merchantId: m, amount: cop(5_000) });
    const ok = await withTenantTransaction(ctx.app, org, (c) =>
      otherConfirm.beginIn(c, org, i2.id)
    );
    expect(ok.intent.status).toBe('processing');

    // Payout por el proveedor cortado: bloqueado aun con saldo disponible.
    await seedAvailable(org, m, 50_000);
    const blockedPayouts = new PayoutService(ctx.app, posting, namedProvider(name));
    await expectSuspended(
      blockedPayouts.create(org, { merchantId: m, amount: 10_000n, currency: 'COP' })
    );
    const okPayouts = new PayoutService(ctx.app, posting, namedProvider(uniqueProvider()));
    const payout = await okPayouts.create(org, {
      merchantId: m,
      amount: 10_000n,
      currency: 'COP',
    });
    expect(payout.status).toBe('requested');
  });

  it('merchant: bloquea payouts del comercio cortado', async () => {
    const { org, m } = await scenario();
    await seedAvailable(org, m, 30_000);
    await engage('merchant', m);
    const payouts = new PayoutService(ctx.app, posting, namedProvider(uniqueProvider()));
    await expectSuspended(payouts.create(org, { merchantId: m, amount: 1_000n, currency: 'COP' }));
  });
});

describe('revisión PR #104: huecos del corte', () => {
  it('payout `requested` ANTES del corte: execute/re-drive NO lo envía al banco (falla limpio)', async () => {
    const { org, m } = await scenario();
    await seedAvailable(org, m, 40_000);
    const inner = namedProvider(uniqueProvider());
    let submitted = 0;
    const provider: PaymentProvider = {
      ...inner,
      submitPayout: (i) => {
        submitted += 1;
        return inner.submitPayout!(i);
      },
    };
    const payouts = new PayoutService(ctx.app, posting, provider);
    // Fase 1 antes del corte (el execute fire-and-forget nunca corrió: crash).
    const p = await payouts.create(org, { merchantId: m, amount: 15_000n, currency: 'COP' });
    await engage('merchant', m);

    // Lo que haría el redriver (F4-07e) al vencer el lease.
    await payouts.execute(org, p.id);

    expect(submitted).toBe(0);
    const after = await payouts.get(org, p.id);
    expect(after.status).toBe('failed');
    expect(after.failureCode).toBe('flow_suspended');
    // Re-ejecutar es no-op (terminal): no queda en bucle para el redriver.
    await payouts.execute(org, p.id);
    expect(submitted).toBe(0);
  });

  it('el motor impide requested→in_transit aunque un servicio no lo sepa', async () => {
    const { org, m } = await scenario();
    await seedAvailable(org, m, 10_000);
    const payouts = new PayoutService(ctx.app, posting, namedProvider(uniqueProvider()));
    const p = await payouts.create(org, { merchantId: m, amount: 5_000n, currency: 'COP' });
    await engage('merchant', m);
    await expectSuspended(
      ctx.admin.query(`UPDATE payouts SET status = 'in_transit' WHERE id = $1`, [p.id])
    );
  });

  it('provider: el corte casa aunque el proveedor se registre con mayúsculas', async () => {
    const { org, m } = await scenario();
    const name = uniqueProvider();
    const confirm = new PaymentConfirmationService(
      ctx.app,
      intents,
      posting,
      namedProvider(name.toUpperCase()),
      ZERO_FEE_SCHEDULE
    );
    await engage('provider', name);
    const i = await intents.create({ tenantId: org, merchantId: m, amount: cop(5_000) });
    await expectSuspended(
      withTenantTransaction(ctx.app, org, (c) => confirm.beginIn(c, org, i.id))
    );
  });

  it('tenant: cortar la organización alcanza también a comercios creados DESPUÉS del corte', async () => {
    const { org, m } = await scenario();
    await engage('tenant', org.toUpperCase()); // normaliza a minúsculas
    await expectSuspended(intents.create({ tenantId: org, merchantId: m, amount: cop(1_000) }));

    // El atajo obvio para esquivar un corte por comercio: crear otro comercio.
    const res = await ctx.admin.query<{ id: string }>(
      `INSERT INTO merchants (tenant_id, name, country) VALUES ($1, $2, 'CO') RETURNING id`,
      [org, `ks-shop-${randomUUID().slice(0, 8)}`]
    );
    await expectSuspended(
      intents.create({ tenantId: org, merchantId: res.rows[0]!.id, amount: cop(1_000) })
    );
    // Otra organización no se ve afectada.
    const other = await scenario();
    const ok = await intents.create({
      tenantId: other.org,
      merchantId: other.m,
      amount: cop(1_000),
    });
    expect(ok.status).toBe('created');
  });

  it('tenant: rechaza organizaciones inexistentes', async () => {
    await expect(
      admin.engage({ scope: 'tenant', target: randomUUID(), reason: 'x', actorId: OPS })
    ).rejects.toBeInstanceOf(KillSwitchUnknownTenantError);
  });
});

describe('guard del motor: qué NO corta', () => {
  it('lo que ya estaba en vuelo se resuelve: un attempt enviado antes del corte se captura', async () => {
    const { org, m } = await scenario();
    const confirmation = new PaymentConfirmationService(
      ctx.app,
      intents,
      posting,
      new MockPaymentProvider(),
      ZERO_FEE_SCHEDULE
    );
    const intent = await intents.create({ tenantId: org, merchantId: m, amount: cop(15_000) });
    const { attemptId } = await withTenantTransaction(ctx.app, org, (c) =>
      confirmation.beginIn(c, org, intent.id)
    );
    await engage('merchant', m);

    // El proveedor ya tenía el pago: el ledger DEBE reflejarlo.
    await confirmation.execute(org, attemptId, 'tok_approve');
    expect((await intents.get(org, intent.id)).status).toBe('succeeded');
  });
});

describe('liberar restaura el flujo', () => {
  it('tras release, el mismo comercio vuelve a cobrar; el historial conserva ambos actos', async () => {
    const { org, m } = await scenario();
    const { killSwitch } = await engage('merchant', m);
    await expectSuspended(intents.create({ tenantId: org, merchantId: m, amount: cop(1_000) }));

    const released = await admin.release({
      id: killSwitch.id,
      reason: 'dictamen favorable',
      actorId: OTHER_OPS,
    });
    expect(released.releasedAt).not.toBeNull();
    expect(released.releasedBy).toBe(OTHER_OPS);
    expect(released.releaseReason).toBe('dictamen favorable');

    const ok = await intents.create({ tenantId: org, merchantId: m, amount: cop(1_000) });
    expect(ok.status).toBe('created');

    const history = await admin.history(500);
    expect(history.find((k) => k.id === killSwitch.id)?.releasedAt).toBe(released.releasedAt);
    expect((await admin.listActive()).some((k) => k.id === killSwitch.id)).toBe(false);

    // Re-activar después de liberar crea un interruptor NUEVO (historial intacto).
    const again = await engage('merchant', m);
    expect(again.created).toBe(true);
    expect(again.killSwitch.id).not.toBe(killSwitch.id);
  });
});

describe('plano de plataforma: gobierno del interruptor', () => {
  it('engage es idempotente por (scope, target) y ambos actos quedan auditados', async () => {
    const { m } = await scenario();
    const first = await engage('merchant', m);
    const second = await admin.engage({
      scope: 'merchant',
      target: m,
      reason: 'otra orden',
      actorId: OPS,
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.killSwitch.id).toBe(first.killSwitch.id);
    expect(second.killSwitch.reason).toBe('test merchant'); // no se reescribe

    const audit = await ctx.admin.query<{
      reason: string;
      risk_level: string;
      auth_method: string;
      after_summary: { operation: string; killSwitchId: string; created: boolean };
    }>(
      `SELECT reason, risk_level, auth_method, after_summary FROM audit_events
       WHERE action = 'platform.operation' AND after_summary->>'killSwitchId' = $1
       ORDER BY id`,
      [first.killSwitch.id]
    );
    expect(audit.rows.map((r) => [r.reason, r.after_summary.created])).toEqual([
      ['test merchant', true],
      ['otra orden', false],
    ]);
    expect(audit.rows.every((r) => r.risk_level === 'high' && r.auth_method === 'platform')).toBe(
      true
    );
    expect(audit.rows[0]!.after_summary.operation).toBe('kill_switch.engage');
  });

  it('sin razón no hay corte ni liberación (y no se escribe nada)', async () => {
    const { m } = await scenario();
    await expect(
      admin.engage({ scope: 'merchant', target: m, reason: '   ', actorId: OPS })
    ).rejects.toBeInstanceOf(ZodError);
    const rows = await ctx.admin.query(`SELECT 1 FROM kill_switches WHERE target = $1`, [m]);
    expect(rows.rowCount).toBe(0);

    const { killSwitch } = await engage('merchant', m);
    await expect(
      admin.release({ id: killSwitch.id, reason: '', actorId: OPS })
    ).rejects.toBeInstanceOf(ZodError);
    expect((await admin.listActive()).some((k) => k.id === killSwitch.id)).toBe(true);
  });

  it('rechaza objetivos mal formados y comercios inexistentes', async () => {
    await expect(
      admin.engage({ scope: 'country', target: 'VEN', reason: 'x', actorId: OPS })
    ).rejects.toBeInstanceOf(ZodError);
    await expect(
      admin.engage({ scope: 'merchant', target: 'not-a-uuid', reason: 'x', actorId: OPS })
    ).rejects.toBeInstanceOf(ZodError);
    await expect(
      admin.engage({ scope: 'provider', target: 'Mock Bank!', reason: 'x', actorId: OPS })
    ).rejects.toBeInstanceOf(ZodError);
    await expect(
      admin.engage({ scope: 'merchant', target: randomUUID(), reason: 'x', actorId: OPS })
    ).rejects.toBeInstanceOf(KillSwitchUnknownMerchantError);
    await expect(
      admin.engage({ scope: 'country', target: 'ZZ', reason: 'x', actorId: 'ops:ana' })
    ).rejects.toBeInstanceOf(ZodError);
  });

  it('release: inexistente → not found; doble release → already released', async () => {
    await expect(
      admin.release({ id: randomUUID(), reason: 'x', actorId: OPS })
    ).rejects.toBeInstanceOf(KillSwitchNotFoundError);

    const { m } = await scenario();
    const { killSwitch } = await engage('merchant', m);
    await admin.release({ id: killSwitch.id, reason: 'ok', actorId: OPS });
    await expect(
      admin.release({ id: killSwitch.id, reason: 'otra vez', actorId: OPS })
    ).rejects.toBeInstanceOf(KillSwitchAlreadyReleasedError);
  });
});

describe('el motor protege la tabla', () => {
  it('los roles de runtime no pueden leer, activar ni liberar interruptores', async () => {
    const { org } = await scenario();
    await expect(
      withTenantTransaction(ctx.app, org, (c) => c.query(`SELECT 1 FROM kill_switches LIMIT 1`))
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      withTenantTransaction(ctx.app, org, (c) =>
        c.query(
          `INSERT INTO kill_switches (scope, target, reason, engaged_by)
           VALUES ('country', 'ZZ', 'x', gen_random_uuid())`
        )
      )
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('las filas no se borran ni se editan; solo se liberan una vez', async () => {
    const { m } = await scenario();
    const { killSwitch } = await engage('merchant', m);
    await expect(
      ctx.admin.query(`DELETE FROM kill_switches WHERE id = $1`, [killSwitch.id])
    ).rejects.toThrow(/FLUVIA/);
    await expect(
      ctx.admin.query(`UPDATE kill_switches SET target = 'ZZ', scope = 'country' WHERE id = $1`, [
        killSwitch.id,
      ])
    ).rejects.toThrow(/FLUVIA_IMMUTABLE/);
    await expect(
      ctx.admin.query(`UPDATE kill_switches SET reason = 'reescrita' WHERE id = $1`, [
        killSwitch.id,
      ])
    ).rejects.toThrow(/FLUVIA_IMMUTABLE/);
    // Liberar sin razón: lo impide el CHECK del motor.
    await expect(
      ctx.admin.query(`UPDATE kill_switches SET released_at = now() WHERE id = $1`, [killSwitch.id])
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('un solo interruptor activo por objetivo, también a nivel de motor', async () => {
    const { m } = await scenario();
    await engage('merchant', m);
    await expect(
      ctx.admin.query(
        `INSERT INTO kill_switches (scope, target, reason, engaged_by)
         VALUES ('merchant', $1, 'dup', gen_random_uuid())`,
        [m]
      )
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('el formato del objetivo se valida también en el motor', async () => {
    await expect(
      ctx.admin.query(
        `INSERT INTO kill_switches (scope, target, reason, engaged_by)
         VALUES ('country', 've', 'x', gen_random_uuid())`
      )
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('el guard no es invocable directamente por el rol de la app', async () => {
    const { org, m } = await scenario();
    await expect(
      withTenantTransaction(ctx.app, org, (c) =>
        c.query(`SELECT fluvia_assert_flow_allowed($1::uuid, NULL)`, [m])
      )
    ).rejects.toMatchObject({ code: '42501' });
  });
});

/** Deja `merchant.available = amount` y la caja de plataforma para pagarlo. */
async function seedAvailable(org: string, merchantId: string, amount: number): Promise<void> {
  const src = randomUUID();
  const base = { tenantId: org, merchantId, sourceId: src, amount: cop(amount) };
  await posting.capturePayment({
    ...base,
    idempotencyKey: `cap:${src}`,
    sourceType: 'payment_attempt',
  });
  await posting.receiveProviderSettlement({
    ...base,
    idempotencyKey: `prov:${src}`,
    sourceType: 'settlement',
  });
  await posting.releaseSettlement({
    ...base,
    idempotencyKey: `settle:${src}`,
    sourceType: 'settlement',
  });
}
