import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, dbUrlsFromEnv, type Pool } from '@fluvia/db';
import {
  buildShowroomSemanticManifest,
  serializeShowroomManifest,
  type ShowroomSemanticManifest,
} from '../src/manifest.js';
import { verifyShowroomTarget, type VerifiedShowroomTarget } from '../src/live-identity.js';
import { prepareShowroomDatabase } from '../src/reset.js';
import {
  SHOWROOM,
  SHOWROOM_EXPECTED_BALANCES,
  ShowroomAlreadySeededError,
  ShowroomEnvironmentError,
  seedShowroom,
  type ShowroomPools,
  type ShowroomSeedResult,
} from '../src/showroom.js';
import {
  MAINTENANCE_URL,
  ephemeralDbName,
  resetRequestFor,
  snapshotCounts,
} from './showroom-helpers.js';

/**
 * F6.5C3 — `seedShowroom` sobre una base efimera dedicada RECIEN migrada:
 * dataset completo por servicios normativos, politica de base vacia
 * (segunda corrida = fail-closed con CERO mutaciones), manifiesto semantico
 * sin IDs/timestamps/secretos, y base principal del job INTACTA.
 */

const DB = ephemeralDbName();
const REQ = resetRequestFor(DB);

let pools: ShowroomPools;
let target: VerifiedShowroomTarget;
let manifest: ShowroomSemanticManifest;
let seedResult: ShowroomSeedResult;

beforeAll(async () => {
  await prepareShowroomDatabase(REQ);
  pools = {
    admin: createPool({ connectionString: REQ.targetUrls.admin, max: 4 }),
    app: createPool({ connectionString: REQ.targetUrls.app, max: 8 }),
    auth: createPool({ connectionString: REQ.targetUrls.auth, max: 2 }),
    relay: createPool({ connectionString: REQ.targetUrls.relay, max: 2 }),
    webhook: createPool({ connectionString: REQ.targetUrls.webhook, max: 2 }),
  };
  // Contrato nuevo (EXT-001): seedShowroom exige el handle verificado —
  // attestation live real de los cinco pools contra la base efimera dedicada.
  target = await verifyShowroomTarget('test', pools);
}, 120_000);

afterAll(async () => {
  await Promise.all(Object.values(pools).map((p: Pool) => p.end()));
  const maintenance = createPool({ connectionString: MAINTENANCE_URL, max: 1 });
  await maintenance.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => undefined);
  await maintenance.end();
});

describe('seedShowroom (dataset normativo, secuencial)', () => {
  it('rechaza entornos fuera de local/test ANTES de tocar la base', async () => {
    for (const env of ['sandbox', 'staging', 'production']) {
      await expect(
        // Handle nulo a proposito: el guard de entorno corre ANTES incluso
        // de validar el handle o tocar conexion alguna (patron seedDemo/F1-10).
        seedShowroom(env, null as unknown as VerifiedShowroomTarget)
      ).rejects.toBeInstanceOf(ShowroomEnvironmentError);
    }
  });

  it('sobre una base recien migrada y vacia construye el dataset COMPLETO via servicios', async () => {
    seedResult = await seedShowroom('test', target);
    expect(seedResult.organizationId).toMatch(/^[0-9a-f-]{36}$/);

    // Identidad SOLO por servicios: los usuarios existen en el plano auth con
    // password scrypt y verificacion sellada por el flujo real (C1), la org
    // es unica (C2) y el merchant vino del helper de onboarding (C2).
    const users = await pools.admin.query<{
      email: string;
      password_hash: string | null;
      email_verified_at: Date | null;
    }>(
      `SELECT email, password_hash, email_verified_at FROM users
         WHERE email LIKE '%@showroom.fluvia.test' ORDER BY email`
    );
    expect(users.rows.map((u) => u.email)).toEqual([
      SHOWROOM.users.owner.email,
      SHOWROOM.users.reviewer.email,
    ]);
    for (const u of users.rows) {
      expect(u.password_hash).toMatch(/^scrypt\$/);
      expect(u.email_verified_at).not.toBeNull();
    }
    // El token de verificacion se CONSUMIO dentro de la transaccion atomica.
    const tokens = await pools.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM email_verification_tokens WHERE consumed_at IS NULL`
    );
    expect(Number(tokens.rows[0]!.n)).toBe(0);

    const orgs = await pools.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM organizations WHERE name = '${SHOWROOM.organizationName}'`
    );
    expect(Number(orgs.rows[0]!.n)).toBe(1);
    const demo = await pools.admin.query(`SELECT 1 FROM organizations WHERE name = 'Demo Fluvia'`);
    expect(demo.rowCount).toBe(0); // Demo Fluvia NO existe en la base dedicada

    // Chart presente: cuentas de plataforma + merchant-scoped del catalogo.
    const accounts = await pools.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ledger_accounts WHERE tenant_id = $1`,
      [seedResult.organizationId]
    );
    expect(Number(accounts.rows[0]!.n)).toBe(14);

    // Estados exactos por entidad (la via normativa los produjo).
    const intentStates = await pools.admin.query<{
      status: string;
      failure_code: string | null;
      n: string;
    }>(
      `SELECT status, failure_code, count(*)::text AS n FROM payment_intents
         GROUP BY status, failure_code ORDER BY status, failure_code`
    );
    expect(
      Object.fromEntries(
        intentStates.rows.map((r) => [`${r.status}:${r.failure_code ?? '-'}`, Number(r.n)])
      )
    ).toEqual({
      'created:-': 2, // sesiones open + expirada envuelven intents sin resolver
      'processing:-': 1, // tok_pse (attempt submitted, pendiente de webhook)
      // aprobado + checkout completado + fondeo + la venta cuyo refund se
      // cancelo por saldo (el intent permanece succeeded)
      'succeeded:-': 4,
      'failed:card_declined': 1,
      'failed:insufficient_funds': 1,
      'canceled:-': 1,
      'refunded:-': 1,
      'partially_refunded:-': 1,
    });
    const pseAttempt = await pools.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM payment_attempts WHERE status = 'submitted'`
    );
    expect(Number(pseAttempt.rows[0]!.n)).toBe(1);

    // Refund canceled y payout failed por el guard REAL del ledger.
    const refundCanceled = await pools.admin.query<{ failure_code: string }>(
      `SELECT failure_code FROM refunds WHERE status = 'canceled'`
    );
    expect(refundCanceled.rows).toHaveLength(1);
    expect(refundCanceled.rows[0]!.failure_code).toBe('insufficient_merchant_balance');
    const payoutFailed = await pools.admin.query<{ failure_code: string }>(
      `SELECT failure_code FROM payouts WHERE status = 'failed'`
    );
    expect(payoutFailed.rows).toHaveLength(1);
    expect(payoutFailed.rows[0]!.failure_code).toBe('insufficient_merchant_balance');

    // MockProvider es el UNICO provider en todo el dataset.
    const providers = await pools.admin.query<{ provider: string }>(
      `SELECT DISTINCT provider FROM payment_attempts
         UNION SELECT DISTINCT provider FROM refunds
         UNION SELECT DISTINCT provider FROM payouts
         UNION SELECT DISTINCT provider FROM disputes
         UNION SELECT DISTINCT provider FROM settlement_reports`
    );
    expect(providers.rows.map((r) => r.provider)).toEqual(['mock']);

    // API key test creada por el servicio (HMAC v2, secreto solo en memoria).
    const keys = await pools.admin.query<{
      label: string;
      environment: string;
      key_hash_version: number;
    }>(`SELECT label, environment, key_hash_version FROM api_keys`);
    expect(keys.rows).toEqual([
      { label: SHOWROOM.apiKeyLabel, environment: 'test', key_hash_version: 2 },
    ]);
    expect(seedResult.sandbox.apiKey.secret).toMatch(/^fluvia_sk_test_/);

    // Webhooks: delivered y dead por el runtime real (cero red externa).
    const webhookStates = await pools.admin.query<{ status: string; n: string }>(
      `SELECT status, count(*)::text AS n FROM webhook_events GROUP BY status`
    );
    expect(Object.fromEntries(webhookStates.rows.map((r) => [r.status, Number(r.n)]))).toEqual({
      delivered: 1,
      dead: 1,
    });
    const deadError = await pools.admin.query<{ last_error: string }>(
      `SELECT last_error FROM webhook_events WHERE status = 'dead'`
    );
    expect(deadError.rows[0]!.last_error).toContain('disabled');

    // Auditoria NATURAL de los servicios (jamas insertada a mano).
    const audit = await pools.admin.query<{ action: string; n: string }>(
      `SELECT action, count(*)::text AS n FROM audit_events GROUP BY action ORDER BY action`
    );
    expect(Object.fromEntries(audit.rows.map((r) => [r.action, Number(r.n)]))).toEqual({
      'api_key.created': 1,
      'membership.created': 1,
      'merchant.created': 1,
      'operational_case.acknowledged': 1,
      'operational_case.adjustment_applied': 1,
      'operational_case.adjustment_proposed': 1,
      'organization.created': 1,
      'user.email_verified': 2,
      'user.registered': 2,
      'webhook_endpoint.created': 2,
      'webhook_endpoint.disabled': 1,
    });

    // Four-eyes REAL: propone el owner, aprueba la revisora (actores distintos).
    const adj = await pools.admin.query<{
      status: string;
      requires_second_approval: boolean;
      distinct_actors: boolean;
    }>(
      `SELECT status, requires_second_approval,
                (approved_by_user_id IS DISTINCT FROM proposed_by_user_id) AS distinct_actors
         FROM case_adjustments`
    );
    expect(adj.rows).toEqual([
      { status: 'applied', requires_second_approval: true, distinct_actors: true },
    ]);
  }, 480_000);

  it('una SEGUNDA ejecucion sobre la misma base aborta fail-closed con CERO mutaciones', async () => {
    const before = await snapshotCounts(pools.admin);
    await expect(seedShowroom('test', target)).rejects.toBeInstanceOf(ShowroomAlreadySeededError);
    const after = await snapshotCounts(pools.admin);
    expect(after).toEqual(before);
  });

  it('el manifiesto semantico es canonico y NO contiene IDs, timestamps, secretos ni refs', async () => {
    manifest = await buildShowroomSemanticManifest(pools.admin);

    // Cantidades y estados exactos.
    expect(manifest.organization).toEqual({
      name: SHOWROOM.organizationName,
      slug: SHOWROOM.slug,
    });
    expect(manifest.users).toEqual([
      { email: SHOWROOM.users.owner.email, membershipRole: 'owner' },
      { email: SHOWROOM.users.reviewer.email, membershipRole: null },
    ]);
    expect(manifest.reconciliation.classes).toEqual({
      matched: 4,
      amount_mismatch: 1,
      missing_in_ledger: 1,
      missing_at_provider: 1,
    });
    expect(manifest.reconciliation.cases).toEqual({ open: 1, acknowledged: 1, resolved: 1 });
    expect(manifest.reconciliation.adjustment).toEqual({
      status: 'applied',
      amount: '75000',
      currency: 'COP',
      requiresSecondApproval: true,
      approvedByDistinctActor: true,
    });
    expect(manifest.webhooks.events).toEqual({ delivered: 1, dead: 1, pending: 0 });
    // Balances finales EXACTOS de la historia financiera del showroom.
    expect(manifest.balances).toEqual(SHOWROOM_EXPECTED_BALANCES);

    const serialized = serializeShowroomManifest(manifest);
    // Serializacion estable: volver a construir y serializar da bytes identicos.
    const again = serializeShowroomManifest(await buildShowroomSemanticManifest(pools.admin));
    expect(again).toBe(serialized);

    // Aserciones NEGATIVAS del contrato de exclusion.
    const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    expect(serialized).not.toMatch(uuidRe); // cero UUIDs fisicos
    expect(serialized).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/); // cero timestamps
    expect(serialized).not.toMatch(/fluvia_sk_|whsec_|fluvia_sess|fluvia_verify|cs_[A-Za-z0-9]/); // cero secretos/tokens
    expect(serialized).not.toMatch(/scrypt\$|\$argon|[0-9a-f]{64}/); // cero hashes
    expect(serialized).not.toMatch(/mock_[0-9a-f]|mockr_|mockp_|provider_ref|providerRef/); // cero provider refs
    expect(serialized).not.toContain(SHOWROOM.users.owner.password);
    expect(serialized).not.toContain(SHOWROOM.users.reviewer.password);
  });

  it('la base PRINCIPAL del job quedo intacta (sin org showroom, sin usuarios showroom)', async () => {
    const main = createPool({ connectionString: dbUrlsFromEnv().admin, max: 1 });
    try {
      const org = await main.query(`SELECT 1 FROM organizations WHERE slug = $1 OR name = $2`, [
        SHOWROOM.slug,
        SHOWROOM.organizationName,
      ]);
      expect(org.rowCount).toBe(0);
      const users = await main.query(
        `SELECT 1 FROM users WHERE email LIKE '%@showroom.fluvia.test'`
      );
      expect(users.rowCount).toBe(0);
    } finally {
      await main.end();
    }
  });
});
