import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbUrlsFromEnv } from '../src/config.js';
import type { PoolClient } from '../src/index.js';
import { createTestContext, type TestContext } from '../src/testing.js';

const execFileAsync = promisify(execFile);

/**
 * F6 (threat model §5, fila Ledger) — HASH-CHAIN de tamper-evidence (0042).
 *
 * El append-only del ledger vive en triggers y un superusuario puede
 * DESACTIVARLOS (tier superior del §4). Estas pruebas demuestran que la cadena
 * detecta exactamente ese ataque — incluido el ENCUBRIMIENTO PERFECTO (borrar
 * una transacción balanceada completa) que deja verdes los checks [1..6] de
 * `verify-ledger-invariants.sql`.
 *
 * Diseño deliberado del test: el sellado usa la FUNCIÓN de la migración
 * (`seal_ledger_checkpoints`) y la verificación usa el SCRIPT autocontenido
 * (`verify-ledger-invariants.sql` vía psql, como CI y el restore drill). Los
 * dos duplican el canónico POR CONTRATO — si derivan un byte, estos tests
 * rompen. Todo tampering se COMMITEA y se REPARA byte-exacto (try/finally):
 * la BD queda verde para el paso de invariantes de CI que corre tras la suite.
 */

const INVARIANTS_SQL = fileURLToPath(
  new URL('../../../scripts/verify-ledger-invariants.sql', import.meta.url)
);

let ctx: TestContext;
let adminUrl: string;
let org: string;
let acctDebit: string;
let acctCredit: string;

interface SealResult {
  checkpointsTotal: number;
  sealedUptoSeq: number;
  sealedThisRun: number;
  candidateUptoSeq: number;
}

/** Una corrida del sellador (edad mínima 0: estos tests son el único escritor). */
async function sealOnce(): Promise<SealResult> {
  const res = await ctx.admin.query<{ metric: string; value: string }>(
    `SELECT metric, value::text FROM seal_ledger_checkpoints(interval '0')`
  );
  const m = Object.fromEntries(res.rows.map((r) => [r.metric, Number(r.value)]));
  return {
    checkpointsTotal: m.checkpoints_total ?? 0,
    sealedUptoSeq: m.sealed_upto_seq ?? 0,
    sealedThisRun: m.sealed_this_run ?? 0,
    candidateUptoSeq: m.candidate_upto_seq ?? 0,
  };
}

/** Sella TODO lo pendiente: candidato (fase 1) + finalización (fase 2). */
async function sealAll(): Promise<SealResult> {
  await sealOnce();
  return sealOnce();
}

/** Corre el script REAL de invariantes vía psql, como CI. Nunca lanza. */
async function runInvariants(): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('psql', [
      adminUrl,
      '-v',
      'ON_ERROR_STOP=1',
      '-f',
      INVARIANTS_SQL,
    ]);
    return { ok: true, output: stdout + stderr };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, output: (err.stdout ?? '') + (err.stderr ?? '') };
  }
}

/** Inserta una transacción BALANCEADA (2 asientos) como superusuario. */
async function insertBalancedTx(amount: number): Promise<string> {
  const client: PoolClient = await ctx.admin.connect();
  try {
    await client.query('BEGIN');
    const tx = await client.query<{ id: string }>(
      `INSERT INTO ledger_transactions (tenant_id, idempotency_key, reason, source_type, source_id)
       VALUES ($1, $2, 'adjustment', 'chain-test', $3) RETURNING id`,
      [org, `chain-${randomUUID()}`, `src-${randomUUID().slice(0, 8)}`]
    );
    await client.query(
      `INSERT INTO ledger_entries (tenant_id, tx_root_id, account_id, direction, amount, currency, reason)
       VALUES ($1, $2, $3, 'debit', $5, 'USD', 'adjustment'),
              ($1, $2, $4, 'credit', $5, 'USD', 'adjustment')`,
      [org, tx.rows[0]!.id, acctDebit, acctCredit, amount]
    );
    await client.query('COMMIT');
    return tx.rows[0]!.id;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  ctx = await createTestContext();
  adminUrl = dbUrlsFromEnv().admin;
  org = await ctx.createTenant('Hash Chain Org');
  // Cuentas SIN fila de proyección (los asientos crudos no la materializan):
  // así el encubrimiento no necesita tocar balance_projections y [6] queda
  // verde por sí solo — el escenario más hostil para la detección.
  acctDebit = await ctx.createLedgerAccount({
    tenantId: org,
    name: 'chain-clearing',
    currency: 'USD',
    normalSide: 'debit',
  });
  acctCredit = await ctx.createLedgerAccount({
    tenantId: org,
    name: 'chain-merchant',
    currency: 'USD',
    normalSide: 'credit',
  });
}, 30_000);

afterAll(async () => {
  await ctx.close();
});

describe('sellado en dos fases (candidato → horizonte de txid → checkpoint)', () => {
  it('seals existing entries and the REAL invariants script verifies the chain end-to-end', async () => {
    await insertBalancedTx(11_000);
    const first = await sealOnce(); // fase 1: candidato
    expect(first.candidateUptoSeq).toBeGreaterThan(0);
    const second = await sealOnce(); // fase 2: finaliza
    expect(second.sealedThisRun).toBe(1);
    expect(second.checkpointsTotal).toBeGreaterThanOrEqual(1);
    expect(second.sealedUptoSeq).toBeGreaterThanOrEqual(first.candidateUptoSeq);

    const inv = await runInvariants();
    expect(inv.output).toContain('FLUVIA_INVARIANTS_OK');
    expect(inv.ok).toBe(true);
  }, 30_000);

  it('a candidate is NOT finalized while a transaction from before its horizon is still open (no false positives by design)', async () => {
    // Tx LARGA en vuelo: asigna seq (asientos) y NO commitea todavía — el
    // clásico commit fuera de orden que rompería un sellado ingenuo.
    const longTx = await ctx.admin.connect();
    try {
      await longTx.query('BEGIN');
      const tx = await longTx.query<{ id: string }>(
        `INSERT INTO ledger_transactions (tenant_id, idempotency_key, reason)
         VALUES ($1, $2, 'adjustment') RETURNING id`,
        [org, `chain-long-${randomUUID()}`]
      );
      await longTx.query(
        `INSERT INTO ledger_entries (tenant_id, tx_root_id, account_id, direction, amount, currency, reason)
         VALUES ($1, $2, $3, 'debit', 777, 'USD', 'adjustment'),
                ($1, $2, $4, 'credit', 777, 'USD', 'adjustment')`,
        [org, tx.rows[0]!.id, acctDebit, acctCredit]
      );

      // Una tx POSTERIOR commitea primero (seq mayores, visibles ya).
      await insertBalancedTx(13_000);

      // Fase 1 registra el candidato; la fase 2 NO puede finalizar mientras
      // la tx larga (txid anterior al horizonte del candidato) siga abierta.
      await sealOnce();
      const blocked = await sealOnce();
      expect(blocked.sealedThisRun).toBe(0);
      expect(blocked.candidateUptoSeq).toBeGreaterThan(0);

      // Al commitear, los asientos rezagados entran al segmento ANTES de
      // sellarlo — la cadena queda íntegra, sin falso positivo.
      await longTx.query('COMMIT');
    } finally {
      await longTx.query('ROLLBACK').catch(() => undefined);
      longTx.release();
    }
    const after = await sealOnce();
    expect(after.sealedThisRun).toBe(1);

    const inv = await runInvariants();
    expect(inv.output).toContain('FLUVIA_INVARIANTS_OK');
    expect(inv.ok).toBe(true);
  }, 30_000);

  it('entries newer than the last checkpoint are the documented pending horizon (still green, covered by the next seal)', async () => {
    await sealAll();
    await insertBalancedTx(17_000); // cola sin sellar
    const tail = await runInvariants();
    expect(tail.ok).toBe(true);

    const sealed = await sealAll();
    expect(sealed.checkpointsTotal).toBeGreaterThanOrEqual(2); // cadena enlazada
    const inv = await runInvariants();
    expect(inv.ok).toBe(true);
  }, 30_000);
});

describe('detección de tampering (superusuario que salta los triggers)', () => {
  it('[7]-only: editing the reason of a SEALED entry is invisible to [1..6] but breaks the chain', async () => {
    const txId = await insertBalancedTx(19_000);
    await sealAll();
    const entry = await ctx.admin.query<{ seq: string; reason: string }>(
      `SELECT seq::text, reason FROM ledger_entries WHERE tx_root_id = $1 ORDER BY seq LIMIT 1`,
      [txId]
    );
    const seq = entry.rows[0]!.seq;
    const originalReason = entry.rows[0]!.reason;

    try {
      await ctx.admin.query(`ALTER TABLE ledger_entries DISABLE TRIGGER ledger_entries_no_update`);
      await ctx.admin.query(
        `UPDATE ledger_entries SET reason = 'laundered' WHERE seq = $1::bigint`,
        [seq]
      );
      await ctx.admin.query(`ALTER TABLE ledger_entries ENABLE TRIGGER ledger_entries_no_update`);

      const inv = await runInvariants();
      expect(inv.ok).toBe(false);
      expect(inv.output).toMatch(/\[7\] hash-chain/);
      // Ningún otro check lo ve: el tamper es invisible a [1..6].
      expect(inv.output).not.toMatch(/\[[1-6]\]/);
    } finally {
      // Reparación byte-exacta SIEMPRE (la BD debe quedar verde para CI).
      await ctx.admin.query(`ALTER TABLE ledger_entries DISABLE TRIGGER ledger_entries_no_update`);
      await ctx.admin.query(`UPDATE ledger_entries SET reason = $2 WHERE seq = $1::bigint`, [
        seq,
        originalReason,
      ]);
      await ctx.admin.query(`ALTER TABLE ledger_entries ENABLE TRIGGER ledger_entries_no_update`);
    }
    const repaired = await runInvariants();
    expect(repaired.output).toContain('FLUVIA_INVARIANTS_OK');
    expect(repaired.ok).toBe(true);
  }, 30_000);

  it('PERFECT COVER-UP: deleting an entire balanced transaction passes [1..6] — ONLY the chain catches it', async () => {
    const txId = await insertBalancedTx(23_000);
    await sealAll();

    // Captura COMPLETA antes de borrar (la reparación debe ser byte-exacta,
    // incluidos id/seq/created_at — OVERRIDING SYSTEM VALUE para el seq).
    // created_at se captura como TEXTO: node-postgres parsea timestamptz a un
    // Date de JS (milisegundos) y perdería los MICROSEGUNDOS — la reparación
    // reinsertaría un canónico distinto y la cadena quedaría rota de verdad.
    const header = (
      await ctx.admin.query(
        `SELECT id, tenant_id, idempotency_key, reason, created_at::text AS created_at,
                source_type, source_id, reverses_tx_id
         FROM ledger_transactions WHERE id = $1`,
        [txId]
      )
    ).rows[0]!;
    const entries = (
      await ctx.admin.query(
        `SELECT id, tenant_id, tx_root_id, account_id, direction, amount, currency, bucket,
                reason, created_at::text AS created_at, seq
         FROM ledger_entries WHERE tx_root_id = $1 ORDER BY seq`,
        [txId]
      )
    ).rows;
    expect(entries.length).toBe(2);

    const client = await ctx.admin.connect();
    try {
      // El "atacante": borra la transacción balanceada COMPLETA. Sin cadena,
      // NADA lo detectaría — [1] ya no tiene filas que sumar, [4] no ve
      // huérfanos, y sin fila de proyección [6] no compara nada.
      await client.query('BEGIN');
      await client.query(`ALTER TABLE ledger_entries DISABLE TRIGGER ledger_entries_no_delete`);
      await client.query(
        `ALTER TABLE ledger_transactions DISABLE TRIGGER ledger_transactions_no_delete`
      );
      await client.query(`DELETE FROM ledger_entries WHERE tx_root_id = $1`, [txId]);
      await client.query(`DELETE FROM ledger_transactions WHERE id = $1`, [txId]);
      await client.query(`ALTER TABLE ledger_entries ENABLE TRIGGER ledger_entries_no_delete`);
      await client.query(
        `ALTER TABLE ledger_transactions ENABLE TRIGGER ledger_transactions_no_delete`
      );
      await client.query('COMMIT');

      const inv = await runInvariants();
      expect(inv.ok).toBe(false);
      expect(inv.output).toMatch(/\[7\] hash-chain/);
      // LA PRUEBA CENTRAL: todos los checks clásicos pasan; solo [7] dispara.
      expect(inv.output).not.toMatch(/\[[1-6]\]/);
    } finally {
      // Reparación: reinsertar header + asientos EXACTOS (mismos id/seq/ts).
      await client.query('BEGIN').catch(() => undefined);
      await client.query(
        `INSERT INTO ledger_transactions (id, tenant_id, idempotency_key, reason, created_at, source_type, source_id, reverses_tx_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO NOTHING`,
        [
          header.id,
          header.tenant_id,
          header.idempotency_key,
          header.reason,
          header.created_at,
          header.source_type,
          header.source_id,
          header.reverses_tx_id,
        ]
      );
      for (const e of entries) {
        await client.query(
          `INSERT INTO ledger_entries (id, tenant_id, tx_root_id, account_id, direction, amount, currency, bucket, reason, created_at, seq)
           OVERRIDING SYSTEM VALUE
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (id) DO NOTHING`,
          [
            e.id,
            e.tenant_id,
            e.tx_root_id,
            e.account_id,
            e.direction,
            e.amount,
            e.currency,
            e.bucket,
            e.reason,
            e.created_at,
            e.seq,
          ]
        );
      }
      await client.query('COMMIT').catch(() => undefined);
      client.release();
    }
    const repaired = await runInvariants();
    expect(repaired.output).toContain('FLUVIA_INVARIANTS_OK');
    expect(repaired.ok).toBe(true);
  }, 30_000);

  it('tampering a sealed CHECKPOINT breaks the link of its successor (the chain protects itself)', async () => {
    // Garantiza >= 2 checkpoints: el eslabón del sucesor delata al tamperado.
    await insertBalancedTx(29_000);
    await sealAll();
    await insertBalancedTx(31_000);
    await sealAll();

    const first = (
      await ctx.admin.query<{ id: string; chain_hash: string }>(
        `SELECT id::text, chain_hash FROM ledger_checkpoints ORDER BY upto_seq ASC LIMIT 1`
      )
    ).rows[0]!;

    try {
      await ctx.admin.query(
        `ALTER TABLE ledger_checkpoints DISABLE TRIGGER ledger_checkpoints_no_update`
      );
      await ctx.admin.query(
        `UPDATE ledger_checkpoints SET chain_hash = repeat('0', 64) WHERE id = $1::bigint`,
        [first.id]
      );
      await ctx.admin.query(
        `ALTER TABLE ledger_checkpoints ENABLE TRIGGER ledger_checkpoints_no_update`
      );

      const inv = await runInvariants();
      expect(inv.ok).toBe(false);
      expect(inv.output).toMatch(/\[7\] hash-chain/);
    } finally {
      await ctx.admin.query(
        `ALTER TABLE ledger_checkpoints DISABLE TRIGGER ledger_checkpoints_no_update`
      );
      await ctx.admin.query(`UPDATE ledger_checkpoints SET chain_hash = $2 WHERE id = $1::bigint`, [
        first.id,
        first.chain_hash,
      ]);
      await ctx.admin.query(
        `ALTER TABLE ledger_checkpoints ENABLE TRIGGER ledger_checkpoints_no_update`
      );
    }
    const repaired = await runInvariants();
    expect(repaired.ok).toBe(true);
  }, 30_000);
});

describe('mínimo privilegio (0042)', () => {
  it('the worker role can EXECUTE the seal function but cannot touch the tables', async () => {
    const viaWorker = await ctx.worker.query(
      `SELECT metric, value::text FROM seal_ledger_checkpoints(interval '0')`
    );
    expect(viaWorker.rows.length).toBeGreaterThan(0);
    await expect(ctx.worker.query('SELECT * FROM ledger_checkpoints')).rejects.toThrow(
      /permission denied/i
    );
    await expect(ctx.worker.query('SELECT * FROM ledger_checkpoint_candidates')).rejects.toThrow(
      /permission denied/i
    );
  });

  it('the app role can neither seal nor read the chain tables', async () => {
    await expect(
      ctx.app.query(`SELECT * FROM seal_ledger_checkpoints(interval '0')`)
    ).rejects.toThrow(/permission denied/i);
    await expect(ctx.app.query('SELECT * FROM ledger_checkpoints')).rejects.toThrow(
      /permission denied/i
    );
  });

  it('sealed checkpoints are append-only even for raw SQL (triggers)', async () => {
    await sealAll();
    await expect(ctx.admin.query(`DELETE FROM ledger_checkpoints`)).rejects.toThrow(
      /FLUVIA_IMMUTABLE/
    );
    await expect(ctx.admin.query(`UPDATE ledger_checkpoints SET entry_count = 0`)).rejects.toThrow(
      /FLUVIA_IMMUTABLE/
    );
  });

  it('seq is GENERATED ALWAYS: nobody can pick it on a normal INSERT', async () => {
    await expect(
      ctx.admin.query(
        `INSERT INTO ledger_entries (tenant_id, tx_root_id, account_id, direction, amount, currency, reason, seq)
         VALUES ($1, gen_random_uuid(), $2, 'debit', 1, 'USD', 'x', 999999999)`,
        [org, acctDebit]
      )
    ).rejects.toThrow(/GENERATED ALWAYS|cannot insert a non-DEFAULT value/i);
  });
});
