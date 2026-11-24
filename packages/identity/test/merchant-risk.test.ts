import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenantTransaction } from '@fluvia/db';
import { createTestContext, type TestContext } from '@fluvia/db/testing';
import { ZodError } from 'zod';
import {
  DenylistEntryAlreadyRetiredError,
  IdentityService,
  InvalidDenylistPatternError,
  MERCHANT_ONBOARDING_BLOCKED_SQLSTATE,
  MerchantNotFoundError,
  MerchantOnboardingBlockedError,
  MerchantRiskAdmin,
} from '../src/index.js';

/**
 * #92 — bloqueo de comercios del Gobierno de Venezuela/PDVSA hasta dictamen y
 * congelación de comercios, contra PG real (migración 0069).
 *
 * Aislamiento: los tests comparten base con otros archivos en paralelo. Los
 * patrones de lista que se añaden son únicos (`zq…`) y se retiran al final;
 * nunca se retira una entrada sembrada por la migración.
 */

let ctx: TestContext;
let service: IdentityService;
let admin: MerchantRiskAdmin;
const OPS = randomUUID();
const addedPatterns: string[] = [];

beforeAll(async () => {
  ctx = await createTestContext();
  service = new IdentityService(ctx.app);
  admin = new MerchantRiskAdmin(ctx.admin);
}, 30_000);

afterAll(async () => {
  for (const id of addedPatterns) {
    await admin.retirePattern({ id, reason: 'test cleanup', actorId: OPS }).catch(() => undefined);
  }
  await ctx.close();
});

const uniq = () => randomUUID().slice(0, 8);

async function platformAudits(resourceId: string) {
  const res = await ctx.admin.query<{ reason: string; actor_id: string; after: unknown }>(
    `SELECT reason, actor_id, after_summary AS after FROM audit_events
     WHERE action = 'platform.operation' AND resource_id = $1 ORDER BY created_at, id`,
    [resourceId]
  );
  return res.rows;
}

describe('alta de comercios: afiliación estatal declarada', () => {
  it('la declaración es obligatoria en el servicio (sin default que la invente)', async () => {
    const org = await ctx.createTenant();
    await expect(
      service.createMerchant(org, { name: `Sin declarar ${uniq()}` } as never)
    ).rejects.toBeInstanceOf(ZodError);
    await expect(
      service.createMerchant(org, {
        name: `Valor raro ${uniq()}`,
        stateAffiliation: 'private',
      } as never)
    ).rejects.toBeInstanceOf(ZodError);
  });

  it('none: se crea, la expone en el DTO y queda como evidencia en la auditoría', async () => {
    const org = await ctx.createTenant();
    const m = await service.createMerchant(
      org,
      { name: `Privada ${uniq()}`, stateAffiliation: 'none' },
      { actorType: 'user', actorId: randomUUID(), authMethod: 'session' }
    );
    expect(m.stateAffiliation).toBe('none');
    expect((await service.getMerchant(org, m.id)).stateAffiliation).toBe('none');
    const audit = await ctx.admin.query<{ after: { stateAffiliation?: string } }>(
      `SELECT after_summary AS after FROM audit_events
       WHERE action = 'merchant.created' AND resource_id = $1`,
      [m.id]
    );
    expect(audit.rows[0]!.after.stateAffiliation).toBe('none');
  });

  it.each(['government', 'state_owned'] as const)(
    '%s: el motor rechaza el alta (general y onboarding) y no queda nada a medias',
    async (affiliation) => {
      const org = await ctx.createTenant();
      const name = `Estatal ${uniq()}`;
      await expect(
        service.createMerchant(org, { name, stateAffiliation: affiliation })
      ).rejects.toBeInstanceOf(MerchantOnboardingBlockedError);
      await expect(
        service.ensureMerchantForOnboarding(
          org,
          { name, stateAffiliation: affiliation },
          { actorType: 'user', actorId: randomUUID(), authMethod: 'session' }
        )
      ).rejects.toBeInstanceOf(MerchantOnboardingBlockedError);
      const rows = await ctx.admin.query('SELECT 1 FROM merchants WHERE tenant_id = $1', [org]);
      expect(rows.rowCount).toBe(0);
      const audits = await ctx.admin.query(
        `SELECT 1 FROM audit_events WHERE tenant_id = $1 AND action = 'merchant.created'`,
        [org]
      );
      expect(audits.rowCount).toBe(0);
    }
  );

  it('el bloqueo no depende del servicio: un INSERT directo (incluso admin) falla con FV452', async () => {
    const org = await ctx.createTenant();
    await expect(
      ctx.admin.query(
        `INSERT INTO merchants (tenant_id, name, state_affiliation) VALUES ($1, $2, 'state_owned')`,
        [org, `Directo ${uniq()}`]
      )
    ).rejects.toMatchObject({ code: MERCHANT_ONBOARDING_BLOCKED_SQLSTATE });
  });
});

describe('alta de comercios: lista de bloqueo de nombres', () => {
  it.each([
    'PDVSA',
    'P.D.V.S.A.',
    'pdvsa gas, s.a.',
    'Petróleos de Venezuela S.A.',
    'PETROLEOS  DE   VENEZUELA',
    'Banco Central de Venezuela',
    'Ministerio del Poder Popular para la Salud',
  ])('rechaza "%s" aunque se declare privada', async (raw) => {
    const org = await ctx.createTenant();
    await expect(
      service.createMerchant(org, { name: raw, stateAffiliation: 'none' })
    ).rejects.toBeInstanceOf(MerchantOnboardingBlockedError);
  });

  it.each(['Xpdvsax Tienda', 'Panadería Venezuela', 'Petróleos Pérez', 'Banco de Venezuela Café'])(
    'no confunde "%s" (coincidencia por palabras completas)',
    async (raw) => {
      const org = await ctx.createTenant();
      const m = await service.createMerchant(org, { name: raw, stateAffiliation: 'none' });
      expect(m.status).toBe('active');
    }
  );

  it('renombrar un comercio a un nombre bloqueado falla; el nombre original queda', async () => {
    const org = await ctx.createTenant();
    const m = await service.createMerchant(org, {
      name: `Renombrable ${uniq()}`,
      stateAffiliation: 'none',
    });
    await expect(
      service.updateMerchant(org, m.id, { name: 'PDVSA Servicios' })
    ).rejects.toBeInstanceOf(MerchantOnboardingBlockedError);
    expect((await service.getMerchant(org, m.id)).name).toBe(m.name);
  });

  it('un patrón nuevo se normaliza en el motor, es idempotente, bloquea y al retirarlo deja de bloquear', async () => {
    const token = `zq${uniq().replace(/[^a-z0-9]/g, '')}`;
    const added = await admin.addPattern({
      pattern: `  ${token.toUpperCase()} Énergía `,
      reason: 'Legal: prueba de lista',
      actorId: OPS,
    });
    addedPatterns.push(added.entry.id);
    expect(added.created).toBe(true);
    expect(added.entry.pattern).toBe(`${token} energia`);
    expect(added.entry.addedBy).toBe(OPS);
    const addAudit = await ctx.admin.query<{ reason: string; risk_level: string }>(
      `SELECT reason, risk_level FROM audit_events
       WHERE action = 'platform.operation' AND after_summary->>'entryId' = $1`,
      [added.entry.id]
    );
    expect(addAudit.rows).toEqual([{ reason: 'Legal: prueba de lista', risk_level: 'high' }]);

    const again = await admin.addPattern({
      pattern: `${token} energia`,
      reason: 'otra vez',
      actorId: OPS,
    });
    expect(again).toMatchObject({ created: false, entry: { id: added.entry.id } });

    const org = await ctx.createTenant();
    await expect(
      service.createMerchant(org, { name: `${token} Energía C.A.`, stateAffiliation: 'none' })
    ).rejects.toBeInstanceOf(MerchantOnboardingBlockedError);

    const retired = await admin.retirePattern({
      id: added.entry.id,
      reason: 'Falso positivo',
      actorId: OPS,
    });
    expect(retired.retiredAt).not.toBeNull();
    await expect(
      admin.retirePattern({ id: added.entry.id, reason: 'x', actorId: OPS })
    ).rejects.toBeInstanceOf(DenylistEntryAlreadyRetiredError);
    const ok = await service.createMerchant(org, {
      name: `${token} Energía C.A.`,
      stateAffiliation: 'none',
    });
    expect(ok.status).toBe('active');

    const listed = await admin.listDenylist({ includeRetired: true });
    expect(listed.find((e) => e.id === added.entry.id)?.retireReason).toBe('Falso positivo');
    expect((await admin.listDenylist()).some((e) => e.id === added.entry.id)).toBe(false);
  });

  it('valida patrón, razón y operador', async () => {
    await expect(
      admin.addPattern({ pattern: '...', reason: 'x', actorId: OPS })
    ).rejects.toBeInstanceOf(InvalidDenylistPatternError);
    await expect(
      admin.addPattern({ pattern: 'zq valido', reason: '   ', actorId: OPS })
    ).rejects.toBeInstanceOf(ZodError);
    await expect(
      admin.addPattern({ pattern: 'zq valido', reason: 'ok', actorId: 'operador' })
    ).rejects.toBeInstanceOf(ZodError);
  });

  it('la tabla es evidencia: sin DELETE, sin editar, y el motor exige el patrón normalizado', async () => {
    const seeded = await ctx.admin.query<{ id: string }>(
      `SELECT id FROM merchant_name_denylist WHERE pattern = 'pdvsa' AND retired_at IS NULL`
    );
    const id = seeded.rows[0]!.id;
    await expect(
      ctx.admin.query('DELETE FROM merchant_name_denylist WHERE id = $1', [id])
    ).rejects.toThrow();
    await expect(
      ctx.admin.query(`UPDATE merchant_name_denylist SET pattern = 'otro' WHERE id = $1`, [id])
    ).rejects.toThrow(/FLUVIA_IMMUTABLE/);
    await expect(
      ctx.admin.query(
        `INSERT INTO merchant_name_denylist (pattern, reason) VALUES ('PDVSA Bis', 'x')`
      )
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('columnas protegidas y congelación', () => {
  async function merchantFor(org: string) {
    return service.createMerchant(org, { name: `Protegido ${uniq()}`, stateAffiliation: 'none' });
  }

  it('el rol de runtime NO puede cambiar status, afiliación, país ni tenant (42501)', async () => {
    const org = await ctx.createTenant();
    const other = await ctx.createTenant();
    const m = await merchantFor(org);
    for (const [sql, params] of [
      [`UPDATE merchants SET status = 'frozen' WHERE id = $1`, [m.id]],
      [`UPDATE merchants SET state_affiliation = NULL WHERE id = $1`, [m.id]],
      [`UPDATE merchants SET country = 'ZZ' WHERE id = $1`, [m.id]],
      [`UPDATE merchants SET tenant_id = $2 WHERE id = $1`, [m.id, other]],
    ] as const) {
      await expect(
        withTenantTransaction(ctx.app, org, (c) => c.query(sql, [...params]))
      ).rejects.toMatchObject({ code: '42501' });
    }
    // Lo que sí le corresponde (renombrar) sigue funcionando.
    const renamed = await service.updateMerchant(org, m.id, { name: `${m.name} Bis` });
    expect(renamed.name).toBe(`${m.name} Bis`);
  });

  it('un comercio congelado no puede descongelarse a sí mismo', async () => {
    const org = await ctx.createTenant();
    const m = await merchantFor(org);
    await admin.freeze({ merchantId: m.id, reason: 'Revisión de sanciones', actorId: OPS });
    await expect(
      withTenantTransaction(ctx.app, org, (c) =>
        c.query(`UPDATE merchants SET status = 'active' WHERE id = $1`, [m.id])
      )
    ).rejects.toMatchObject({ code: '42501' });
    expect((await service.getMerchant(org, m.id)).status).toBe('frozen');
  });

  it('freeze/unfreeze: razón obligatoria, auditoría de riesgo alto e idempotencia', async () => {
    const org = await ctx.createTenant();
    const m = await merchantFor(org);
    await expect(
      admin.freeze({ merchantId: m.id, reason: ' ', actorId: OPS })
    ).rejects.toBeInstanceOf(ZodError);

    const frozen = await admin.freeze({ merchantId: m.id, reason: 'Filial estatal', actorId: OPS });
    expect(frozen).toMatchObject({ changed: true, merchant: { status: 'frozen' } });
    const again = await admin.freeze({ merchantId: m.id, reason: 'otra vez', actorId: OPS });
    expect(again.changed).toBe(false);

    const back = await admin.unfreeze({ merchantId: m.id, reason: 'Falso positivo', actorId: OPS });
    expect(back).toMatchObject({ changed: true, merchant: { status: 'active' } });

    const audits = await platformAudits(m.id);
    expect(audits.map((a) => a.reason)).toEqual(['Filial estatal', 'Falso positivo']);
    expect(audits.every((a) => a.actor_id === OPS)).toBe(true);
    const risk = await ctx.admin.query<{ risk_level: string }>(
      `SELECT DISTINCT risk_level FROM audit_events
       WHERE action = 'platform.operation' AND resource_id = $1`,
      [m.id]
    );
    expect(risk.rows.map((r) => r.risk_level)).toEqual(['high']);
  });

  it('hasta dictamen: no se descongela un comercio legado que resulta estatal o con nombre bloqueado', async () => {
    const org = await ctx.createTenant();
    // Legado sin declarar (anterior a 0069), insertado por el plano de plataforma.
    const legacy = await ctx.admin.query<{ id: string }>(
      `INSERT INTO merchants (tenant_id, name) VALUES ($1, $2) RETURNING id`,
      [org, `Legado ${uniq()}`]
    );
    const id = legacy.rows[0]!.id;
    await admin.freeze({ merchantId: id, reason: 'Participación estatal reportada', actorId: OPS });
    // Plataforma corrige la declaración mientras está congelado: permitido.
    await ctx.admin.query(`UPDATE merchants SET state_affiliation = 'state_owned' WHERE id = $1`, [
      id,
    ]);
    await expect(
      admin.unfreeze({ merchantId: id, reason: 'intento', actorId: OPS })
    ).rejects.toBeInstanceOf(MerchantOnboardingBlockedError);
    expect((await admin.getMerchant(id)).status).toBe('frozen');
    // La reactivación fallida no deja auditoría de un cambio que no ocurrió.
    expect((await platformAudits(id)).map((a) => a.reason)).toEqual([
      'Participación estatal reportada',
    ]);
  });

  it('comercio inexistente => MerchantNotFoundError', async () => {
    await expect(
      admin.freeze({ merchantId: randomUUID(), reason: 'x', actorId: OPS })
    ).rejects.toBeInstanceOf(MerchantNotFoundError);
  });
});

describe('screen: triage de comercios ACTIVOS ya existentes', () => {
  it('marca legados con nombre bloqueado o sin declarar, y no los congela solo', async () => {
    const org = await ctx.createTenant();
    // Un comercio legado sin declarar cuyo nombre entra DESPUÉS en la lista:
    // es exactamente el caso de un alta anterior a la decisión de Legal.
    const token = `zq${uniq().replace(/[^a-z0-9]/g, '')}`;
    const legacy = await ctx.admin.query<{ id: string }>(
      `INSERT INTO merchants (tenant_id, name) VALUES ($1, $2) RETURNING id`,
      [org, `${token} Corp`]
    );
    const denylistedId = legacy.rows[0]!.id;
    const entry = await admin.addPattern({ pattern: token, reason: 'screen test', actorId: OPS });
    addedPatterns.push(entry.entry.id);
    const undeclared = await ctx.admin.query<{ id: string }>(
      `INSERT INTO merchants (tenant_id, name) VALUES ($1, $2) RETURNING id`,
      [org, `Legado Limpio ${uniq()}`]
    );
    const declared = await service.createMerchant(org, {
      name: `Declarada ${uniq()}`,
      stateAffiliation: 'none',
    });

    const strict = await admin.screen();
    const hit = strict.find((f) => f.merchant.id === denylistedId);
    expect(hit?.findings).toEqual(['denylisted_name', 'undeclared']);
    expect(strict.some((f) => f.merchant.id === undeclared.rows[0]!.id)).toBe(false);
    expect(strict.some((f) => f.merchant.id === declared.id)).toBe(false);

    const undeclaredId = undeclared.rows[0]!.id;
    const pending = await admin.getMerchant(undeclaredId);
    expect(pending.status).toBe('active');
    expect(pending.stateAffiliation).toBeNull();
    expect(pending.affiliationDeclarationStatus).toBe('pending_review');
    expect((await admin.getMerchant(declared.id)).affiliationDeclarationStatus).toBe('declared');
    expect((await admin.getMerchant(denylistedId)).affiliationDeclarationStatus).toBe(
      'pending_review'
    );
    const flagged = await ctx.admin.query(
      `SELECT 1 FROM merchants
       WHERE id = $1 AND affiliation_declaration_status = 'pending_review'`,
      [undeclaredId]
    );
    expect(flagged.rowCount).toBe(1);

    const all = await admin.screen({ includeUndeclared: true });
    expect(all.find((f) => f.merchant.id === undeclaredId)?.findings).toEqual(['undeclared']);
    expect(all.some((f) => f.merchant.id === declared.id)).toBe(false);
    // screen solo lee; un UPDATE ajeno (updated_at) no rompe al legado, pero
    // renombrarlo o descongelarlo sí pasa por el guard.
    expect((await admin.getMerchant(denylistedId)).status).toBe('active');
    await ctx.admin.query('UPDATE merchants SET updated_at = now() WHERE id = $1', [denylistedId]);
  });
});
