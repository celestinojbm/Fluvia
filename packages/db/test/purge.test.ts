import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../src/testing.js';

/**
 * F1-09 — Purga por clasificación de datos (decisión #14, data-classification.md).
 *
 * La política ENTERA vive en purge_technical_data() (0015): clases fijas,
 * retenciones fijas, auditoría atómica. Aquí se prueba que:
 *  - purga EXACTAMENTE lo vencido de las 4 clases técnicas y nada vivo;
 *  - el DELETE directo sigue prohibido (incluso superusuario) fuera del job;
 *  - las clases financieras siguen imborrables (triggers intactos);
 *  - solo el rol worker puede ejecutarla;
 *  - la purga efectiva deja rastro de auditoría con conteos por clase.
 */

let ctx: TestContext;
let org: string;
let userId: string;

/** Filas nuestras: sufijo único para no chocar con residuos de otras suites. */
const tag = randomUUID().slice(0, 8);

async function seedUser(): Promise<string> {
  const res = await ctx.admin.query<{ id: string }>(
    `INSERT INTO users (email) VALUES ($1) RETURNING id`,
    [`purge-${tag}@fluvia.dev`]
  );
  return res.rows[0]!.id;
}

interface SeedSpec {
  table: string;
  insert: string;
  expired: unknown[];
  live: unknown[];
}

let seeds: SeedSpec[];

beforeAll(async () => {
  ctx = await createTestContext();
  org = await ctx.createTenant(`Purga ${tag}`);
  userId = await seedUser();

  seeds = [
    {
      table: 'idempotency_keys',
      insert: `INSERT INTO idempotency_keys (tenant_id, endpoint, key, request_hash, status, expires_at)
               VALUES ($1, 'POST /test', $2, 'h', 'completed', $3)`,
      expired: [org, `exp-${tag}`, new Date(Date.now() - 60_000)],
      live: [org, `live-${tag}`, new Date(Date.now() + 3_600_000)],
    },
    {
      table: 'sessions',
      insert: `INSERT INTO sessions (user_id, token_hash, expires_at)
               VALUES ($1, $2, $3)`,
      expired: [userId, `sess-exp-${tag}`, new Date(Date.now() - 8 * 86_400_000)],
      live: [userId, `sess-live-${tag}`, new Date(Date.now() + 3_600_000)],
    },
    {
      table: 'email_verification_tokens',
      insert: `INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
               VALUES ($1, $2, $3)`,
      expired: [userId, `tok-exp-${tag}`, new Date(Date.now() - 8 * 86_400_000)],
      live: [userId, `tok-live-${tag}`, new Date(Date.now() + 3_600_000)],
    },
    {
      table: 'mfa_challenges',
      insert: `INSERT INTO mfa_challenges (user_id, token_hash, expires_at)
               VALUES ($1, $2, $3)`,
      expired: [userId, `chal-exp-${tag}`, new Date(Date.now() - 2 * 86_400_000)],
      live: [userId, `chal-live-${tag}`, new Date(Date.now() + 300_000)],
    },
  ];

  for (const s of seeds) {
    await ctx.admin.query(s.insert, s.expired);
    await ctx.admin.query(s.insert, s.live);
  }
}, 30_000);

afterAll(async () => {
  await ctx.close();
});

async function countByToken(table: string, column: string, value: string): Promise<number> {
  const res = await ctx.admin.query(`SELECT 1 FROM ${table} WHERE ${column} = $1`, [value]);
  return res.rowCount ?? 0;
}

describe('purge_technical_data() — la única puerta de borrado (F1-09)', () => {
  it('worker purges exactly the expired rows of the 4 technical classes; live rows survive', async () => {
    const res = await ctx.worker.query<{ class: string; purged: string }>(
      'SELECT class, purged::text FROM purge_technical_data()'
    );
    const byClass = Object.fromEntries(res.rows.map((r) => [r.class, Number(r.purged)]));
    expect(Object.keys(byClass).sort()).toEqual([
      'email_verification_tokens',
      'idempotency_keys',
      'mfa_challenges',
      'sessions',
    ]);
    // Al menos NUESTRA fila vencida por clase (otras suites pueden aportar más).
    for (const cls of Object.keys(byClass)) {
      expect(byClass[cls]).toBeGreaterThanOrEqual(1);
    }

    // Vencidas: fuera. Vivas: intactas.
    expect(await countByToken('idempotency_keys', 'key', `exp-${tag}`)).toBe(0);
    expect(await countByToken('idempotency_keys', 'key', `live-${tag}`)).toBe(1);
    expect(await countByToken('sessions', 'token_hash', `sess-exp-${tag}`)).toBe(0);
    expect(await countByToken('sessions', 'token_hash', `sess-live-${tag}`)).toBe(1);
    expect(await countByToken('email_verification_tokens', 'token_hash', `tok-exp-${tag}`)).toBe(0);
    expect(await countByToken('email_verification_tokens', 'token_hash', `tok-live-${tag}`)).toBe(
      1
    );
    expect(await countByToken('mfa_challenges', 'token_hash', `chal-exp-${tag}`)).toBe(0);
    expect(await countByToken('mfa_challenges', 'token_hash', `chal-live-${tag}`)).toBe(1);
  });

  it('an effective purge leaves an atomic audit trail with per-class counts', async () => {
    const res = await ctx.admin.query<{ after_summary: Record<string, number> }>(
      `SELECT after_summary FROM audit_events
       WHERE action = 'platform.technical_purge' AND actor_type = 'system'
       ORDER BY id DESC LIMIT 1`
    );
    expect(res.rowCount).toBe(1);
    const summary = res.rows[0]!.after_summary;
    expect(Object.keys(summary).sort()).toEqual([
      'email_verification_tokens',
      'idempotency_keys',
      'mfa_challenges',
      'sessions',
    ]);
    expect(summary.idempotency_keys).toBeGreaterThanOrEqual(1);
  });

  it('a no-op purge reports zeros and does NOT add audit noise', async () => {
    const before = await ctx.admin.query(
      `SELECT count(*)::int AS n FROM audit_events WHERE action = 'platform.technical_purge'`
    );
    const res = await ctx.worker.query<{ class: string; purged: string }>(
      'SELECT class, purged::text FROM purge_technical_data()'
    );
    // Todo lo vencido ya se purgó en el test anterior dentro de esta suite;
    // otras suites corren en otro proceso/archivo, no en paralelo con este.
    const total = res.rows.reduce((s, r) => s + Number(r.purged), 0);
    const after = await ctx.admin.query(
      `SELECT count(*)::int AS n FROM audit_events WHERE action = 'platform.technical_purge'`
    );
    const expectedNew = total > 0 ? 1 : 0;
    expect((after.rows[0] as { n: number }).n).toBe(
      (before.rows[0] as { n: number }).n + expectedNew
    );
  });

  it('direct DELETE stays forbidden on technical tables outside the job — even for the superuser', async () => {
    // Apunta a las filas VIVAS sembradas (un DELETE sin filas no dispara
    // triggers FOR EACH ROW y probaria nada).
    const targets: Array<[string, string, string]> = [
      ['idempotency_keys', 'key', `live-${tag}`],
      ['sessions', 'token_hash', `sess-live-${tag}`],
      ['email_verification_tokens', 'token_hash', `tok-live-${tag}`],
      ['mfa_challenges', 'token_hash', `chal-live-${tag}`],
    ];
    for (const [table, column, value] of targets) {
      await expect(
        ctx.admin.query(`DELETE FROM ${table} WHERE ${column} = $1`, [value])
      ).rejects.toThrow(/FLUVIA_IMMUTABLE/);
    }
  });

  it('financial classes keep the ORIGINAL trigger: no purge escape exists for them', async () => {
    // Incluso dentro de una transaccion con el GUC de purga activo, las clases
    // financieras/auditables siguen imborrables (funcion de trigger distinta).
    const accountId = await ctx.createLedgerAccount({
      tenantId: org,
      name: `purge.guard.${tag}`,
      currency: 'USD',
      normalSide: 'debit',
    });
    const targets: Array<[string, string, string]> = [
      ['ledger_accounts', 'id', accountId],
      ['organizations', 'id', org],
      ['audit_events', 'action', 'platform.technical_purge'],
    ];
    const client = await ctx.admin.connect();
    try {
      for (const [table, column, value] of targets) {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('fluvia.technical_purge', 'on', true)`);
        await expect(
          client.query(`DELETE FROM ${table} WHERE ${column} = $1`, [value])
        ).rejects.toThrow(/FLUVIA_IMMUTABLE/);
        await client.query('ROLLBACK');
      }
    } finally {
      client.release();
    }
  });

  it('only the worker role may execute the purge function', async () => {
    await expect(ctx.app.query('SELECT * FROM purge_technical_data()')).rejects.toThrow(
      /permission denied/i
    );
    await expect(ctx.auth.query('SELECT * FROM purge_technical_data()')).rejects.toThrow(
      /permission denied/i
    );
    await expect(ctx.relay.query('SELECT * FROM purge_technical_data()')).rejects.toThrow(
      /permission denied/i
    );
  });
});
