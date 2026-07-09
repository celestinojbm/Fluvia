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
 * El append-only del ledger vive en triggers y un superusuario puede saltarlos
 * (tier superior del §4). Estas pruebas demuestran que la cadena detecta ese
 * ataque — incluido el ENCUBRIMIENTO PERFECTO (borrar una tx balanceada entera)
 * que deja verdes los checks [1..6] de `verify-ledger-invariants.sql`, y el
 * RE-TENANTING de una cabecera sellada (la única columna de cabecera que ninguna
 * otra constraint ata).
 *
 * Aislamiento del test (hallazgo de la revisión adversarial): los ~9 archivos
 * de `packages/db/test` corren EN PARALELO contra el MISMO Postgres. Por eso el
 * bypass de triggers usa `SET LOCAL session_replication_role = replica` DENTRO de
 * una transacción — es de SESIÓN (no `ALTER TABLE ... DISABLE TRIGGER`, que es
 * GLOBAL y dejaría a otros archivos mutar el ledger durante la ventana), revierte
 * solo al COMMIT, y jamás afecta a otra conexión. Todo tampering se COMMITEA y se
 * REPARA en un `finally` best-effort (nunca lanza, nunca fuga cliente): la BD
 * queda verde para el paso de invariantes de CI que corre tras la suite. El
 * sellado usa la FUNCIÓN (0042) y la verificación el SCRIPT (psql, como CI y el
 * restore drill): duplican el canónico POR CONTRATO, así que un byte de deriva
 * entre ellos rompe estas pruebas.
 */

const INVARIANTS_SQL = fileURLToPath(
  new URL('../../../scripts/verify-ledger-invariants.sql', import.meta.url)
);

let ctx: TestContext;
let adminUrl: string;
let org: string;
let otherOrg: string;
let acctDebit: string;
let acctCredit: string;

interface SealResult {
  checkpointsTotal: number;
  sealedUptoSeq: number;
  sealedThisRun: number;
  candidateUptoSeq: number;
  unsealedSeq: number;
}

/** Una corrida del sellador (edad mínima 0: no dependemos del cinturón aquí). */
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
    unsealedSeq: m.unsealed_seq ?? 0,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Sella (dos fases) hasta que la cadena cubra `seq`. Robusto a los otros
 * archivos de test: si alguno mantiene una tx abierta, la fase 2 espera por el
 * horizonte de txid — reintentamos con backoff en vez de asumir "somos el único
 * escritor". Cota dura → FAIL claro, jamás cuelgue ni falso verde.
 */
async function sealUntilCovers(seq: number): Promise<SealResult> {
  let last = await sealOnce();
  for (let i = 0; i < 240 && last.sealedUptoSeq < seq; i += 1) {
    await sleep(25);
    last = await sealOnce();
  }
  if (last.sealedUptoSeq < seq) {
    throw new Error(`la cadena no selló hasta seq ${seq} (sealedUpto=${last.sealedUptoSeq})`);
  }
  return last;
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

/**
 * Ejecuta `fn` como superusuario SALTANDO los triggers append-only, dentro de
 * UNA transacción con `session_replication_role = replica` de SESIÓN (revierte
 * al COMMIT; jamás global). Simula exactamente al adversario del tier superior.
 * Siempre libera el cliente; si `fn` o el COMMIT fallan, hace ROLLBACK y relanza.
 */
async function bypassingTriggers(fn: (c: PoolClient) => Promise<void>): Promise<void> {
  const client = await ctx.admin.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role = replica');
    await fn(client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function currentMaxSeq(): Promise<number> {
  const r = await ctx.admin.query<{ n: string }>(
    `SELECT coalesce(max(seq), 0)::text AS n FROM ledger_entries`
  );
  return Number(r.rows[0]!.n);
}

/** Inserta una transacción BALANCEADA (2 asientos) como superusuario. Devuelve
 *  el txId (de RETURNING, sin re-consultar) y el seq máximo tras el commit. */
async function insertBalancedTx(amount: number): Promise<{ txId: string; maxSeq: number }> {
  const client: PoolClient = await ctx.admin.connect();
  let txId: string;
  try {
    await client.query('BEGIN');
    const tx = await client.query<{ id: string }>(
      `INSERT INTO ledger_transactions (tenant_id, idempotency_key, reason, source_type, source_id)
       VALUES ($1, $2, 'adjustment', 'chain-test', $3) RETURNING id`,
      [org, `chain-${randomUUID()}`, `src-${randomUUID().slice(0, 8)}`]
    );
    txId = tx.rows[0]!.id;
    // max(seq) de ESTA tx (los seq se asignan en el INSERT; el mayor es el marcador).
    const r = await client.query<{ n: string }>(
      `INSERT INTO ledger_entries (tenant_id, tx_root_id, account_id, direction, amount, currency, reason)
       VALUES ($1, $2, $3, 'debit', $5, 'USD', 'adjustment'),
              ($1, $2, $4, 'credit', $5, 'USD', 'adjustment')
       RETURNING seq::text AS n`,
      [org, txId, acctDebit, acctCredit, amount]
    );
    await client.query('COMMIT');
    const maxSeq = Math.max(...r.rows.map((row) => Number(row.n)));
    return { txId, maxSeq };
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
  otherOrg = await ctx.createTenant('Hash Chain Other Org');
  // Cuentas SIN fila de proyección (los asientos crudos no la materializan):
  // así el encubrimiento no necesita tocar balance_projections y [6] queda verde
  // por sí solo — el escenario más hostil para la detección.
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
  it('seals up to a fresh entry and the REAL invariants script verifies the chain', async () => {
    const { maxSeq } = await insertBalancedTx(11_000);
    const sealed = await sealUntilCovers(maxSeq);
    expect(sealed.sealedUptoSeq).toBeGreaterThanOrEqual(maxSeq);
    expect(sealed.checkpointsTotal).toBeGreaterThanOrEqual(1);

    const inv = await runInvariants();
    expect(inv.output).toContain('FLUVIA_INVARIANTS_OK');
    expect(inv.ok).toBe(true);
  }, 30_000);

  it('a candidate is NOT finalized while a transaction from before its horizon is still open', async () => {
    // Tx LARGA en vuelo: asigna seq (asientos) y NO commitea — el clásico commit
    // fuera de orden que rompería un sellado ingenuo. Mientras siga abierta, su
    // txid < el horizonte del candidato ⇒ la fase 2 NO puede finalizar.
    const longTx = await ctx.admin.connect();
    let sealedWhileOpen = 0;
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
      await insertBalancedTx(13_000); // una tx POSTERIOR commitea (seq mayores)

      // Fase 1 registra candidato; la fase 2 no finaliza con la tx larga abierta.
      const before = await sealOnce().then((r) => r.sealedUptoSeq);
      await sealOnce();
      const after = await sealOnce();
      sealedWhileOpen = after.sealedUptoSeq - before;
      expect(after.candidateUptoSeq).toBeGreaterThan(0);
      // La cadena NO avanzó mientras la tx del horizonte seguía abierta.
      expect(sealedWhileOpen).toBe(0);
    } finally {
      await longTx.query('COMMIT').catch(() => undefined);
      longTx.release();
    }
    // Al cerrar la tx larga, los asientos rezagados entran al segmento ANTES de
    // sellarlo → la cadena queda íntegra, sin falso positivo.
    const maxSeq = await currentMaxSeq();
    await sealUntilCovers(maxSeq);
    const inv = await runInvariants();
    expect(inv.output).toContain('FLUVIA_INVARIANTS_OK');
    expect(inv.ok).toBe(true);
  }, 40_000);

  it('a STALE candidate from another cluster (horizon beyond this xid8) is evicted — restore self-heals (fix for the P1 stuck-sealing finding)', async () => {
    // Simula el estado tras un restore lógico a un cluster NUEVO: un candidato
    // cuyo horizon_txid es INALCANZABLE (por delante del contador xid8 actual).
    // Sin la evicción, la fase 2 nunca se cumpliría y el sellado quedaría
    // atascado para siempre. Se inserta con el pool admin (tabla de trabajo).
    await ctx.admin.query(`DELETE FROM ledger_checkpoint_candidates`);
    const maxSeq = await currentMaxSeq();
    await ctx.admin.query(
      `INSERT INTO ledger_checkpoint_candidates (upto_seq, horizon_txid, created_at)
       VALUES ($1, (pg_snapshot_xmax(pg_current_snapshot())::text::bigint + 1000000)::text::xid8, now() - interval '1 day')`,
      [maxSeq]
    );
    // Un sellado debe EVICTAR el candidato inalcanzable (no quedarse atascado).
    await sealOnce();
    const remaining = await ctx.admin.query<{ reachable: boolean | null }>(
      `SELECT (horizon_txid <= pg_snapshot_xmax(pg_current_snapshot())) AS reachable
       FROM ledger_checkpoint_candidates ORDER BY id DESC LIMIT 1`
    );
    // O no quedó candidato (todo sellado) o el que quede tiene horizonte ALCANZABLE.
    if (remaining.rows[0]) {
      expect(remaining.rows[0].reachable).toBe(true);
    }
    // Y el sellado vuelve a progresar normalmente.
    await insertBalancedTx(15_000);
    const target = await currentMaxSeq();
    const sealed = await sealUntilCovers(target);
    expect(sealed.sealedUptoSeq).toBeGreaterThanOrEqual(target);
  }, 40_000);

  it('unsealed_seq (detection lag gauge) drops to 0 once the tail is sealed', async () => {
    await insertBalancedTx(16_000);
    const before = await sealOnce();
    // Tras registrar el candidato hay rezago (o ya estaba al día); tras sellar
    // hasta el máximo, el rezago es 0 — la base de la alerta de estancamiento.
    expect(before.unsealedSeq).toBeGreaterThanOrEqual(0);
    const maxSeq = await currentMaxSeq();
    const after = await sealUntilCovers(maxSeq);
    expect(after.unsealedSeq).toBe(0);
  }, 30_000);
});

describe('detección de tampering (superusuario que salta los triggers)', () => {
  it('[7]-only: editing the reason of a SEALED entry is invisible to [1..6] but breaks the chain', async () => {
    const { maxSeq } = await insertBalancedTx(19_000);
    await sealUntilCovers(maxSeq);
    const entry = await ctx.admin.query<{ seq: string; reason: string }>(
      `SELECT seq::text, reason FROM ledger_entries WHERE seq = $1::bigint`,
      [maxSeq]
    );
    const seq = entry.rows[0]!.seq;
    const originalReason = entry.rows[0]!.reason;

    try {
      await bypassingTriggers((c) =>
        c
          .query(`UPDATE ledger_entries SET reason = 'laundered' WHERE seq = $1::bigint`, [seq])
          .then(() => undefined)
      );
      const inv = await runInvariants();
      expect(inv.ok).toBe(false);
      expect(inv.output).toMatch(/\[7\] hash-chain/);
      // Invisible a [1..6]: ningún otro check dispara.
      expect(inv.output).not.toMatch(/\[[1-6]\] /);
    } finally {
      await bypassingTriggers((c) =>
        c
          .query(`UPDATE ledger_entries SET reason = $2 WHERE seq = $1::bigint`, [
            seq,
            originalReason,
          ])
          .then(() => undefined)
      ).catch(() => undefined);
    }
    const repaired = await runInvariants();
    expect(repaired.output).toContain('FLUVIA_INVARIANTS_OK');
    expect(repaired.ok).toBe(true);
  }, 30_000);

  it('PERFECT COVER-UP: deleting an entire balanced transaction passes [1..6] — ONLY the chain catches it', async () => {
    const { txId, maxSeq } = await insertBalancedTx(23_000);
    await sealUntilCovers(maxSeq);

    // Captura COMPLETA antes de borrar; created_at como TEXTO (el Date de JS
    // truncaría los microsegundos y la reparación cambiaría el canónico).
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

    try {
      // Borra la tx balanceada COMPLETA. Sin cadena NADA lo detectaría: [1] no
      // tiene filas que desbalancear, [4] no ve huérfanos, y sin proyección [6]
      // no compara nada.
      await bypassingTriggers(async (c) => {
        await c.query(`DELETE FROM ledger_entries WHERE tx_root_id = $1`, [txId]);
        await c.query(`DELETE FROM ledger_transactions WHERE id = $1`, [txId]);
      });

      const inv = await runInvariants();
      expect(inv.ok).toBe(false);
      expect(inv.output).toMatch(/\[7\] hash-chain/);
      expect(inv.output).not.toMatch(/\[[1-6]\] /);
    } finally {
      // Reinserta header + asientos EXACTOS (mismos id/seq/ts) bajo replica.
      await bypassingTriggers(async (c) => {
        await c.query(
          `INSERT INTO ledger_transactions (id, tenant_id, idempotency_key, reason, created_at, source_type, source_id, reverses_tx_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
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
          await c.query(
            `INSERT INTO ledger_entries (id, tenant_id, tx_root_id, account_id, direction, amount, currency, bucket, reason, created_at, seq)
             OVERRIDING SYSTEM VALUE VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING`,
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
      }).catch(() => undefined);
    }
    const repaired = await runInvariants();
    expect(repaired.output).toContain('FLUVIA_INVARIANTS_OK');
    expect(repaired.ok).toBe(true);
  }, 40_000);

  it('RE-TENANTING a sealed transaction HEADER is invisible to [1..6] and breaks the chain (proves the canon covers BOTH tables, incl. t.tenant_id)', async () => {
    // La única columna de cabecera que NINGUNA otra constraint ata a los asientos
    // (la FK de coherencia de 0008 es entries<->accounts). Antes de incluir
    // t.tenant_id en el canónico, re-atribuir una cabecera sellada a otro tenant
    // era invisible para [7] Y para [1..6]. Repara vía e.tenant_id (que el FK de
    // coherencia mantiene correcto), sin necesidad de capturar el original.
    const { txId, maxSeq } = await insertBalancedTx(27_000);
    await sealUntilCovers(maxSeq);

    try {
      await bypassingTriggers((c) =>
        c
          .query(`UPDATE ledger_transactions SET tenant_id = $2 WHERE id = $1`, [txId, otherOrg])
          .then(() => undefined)
      );
      const inv = await runInvariants();
      expect(inv.ok).toBe(false);
      expect(inv.output).toMatch(/\[7\] hash-chain/);
      expect(inv.output).not.toMatch(/\[[1-6]\] /);
    } finally {
      await bypassingTriggers((c) =>
        c
          .query(
            `UPDATE ledger_transactions t SET tenant_id =
               (SELECT e.tenant_id FROM ledger_entries e WHERE e.tx_root_id = t.id LIMIT 1)
             WHERE t.id = $1`,
            [txId]
          )
          .then(() => undefined)
      ).catch(() => undefined);
    }
    const repaired = await runInvariants();
    expect(repaired.output).toContain('FLUVIA_INVARIANTS_OK');
    expect(repaired.ok).toBe(true);
  }, 30_000);

  it('DELETING a MIDDLE checkpoint breaks the successor prev-link (exercises [7] chain-continuity, not just self-hash)', async () => {
    // Garantiza >= 3 checkpoints para que exista un intermedio CON sucesor.
    for (const amt of [33_000, 34_000, 35_000]) {
      await insertBalancedTx(amt);
      await sealUntilCovers(await currentMaxSeq());
    }
    // El checkpoint intermedio (2º por upto_seq): borrarlo deja al sucesor con
    // un prev_chain_hash que ya no coincide con el checkpoint anterior VIVO — el
    // eslabón de continuidad de [7], distinto del recomputo de auto-hash.
    const mid = (
      await ctx.admin.query<{
        id: string;
        upto_seq: string;
        entry_count: string;
        segment_hash: string;
        prev_chain_hash: string;
        chain_hash: string;
        sealed_at: string;
      }>(
        `SELECT id::text, upto_seq::text, entry_count::text, segment_hash, prev_chain_hash,
                chain_hash, sealed_at::text
         FROM ledger_checkpoints ORDER BY upto_seq ASC OFFSET 1 LIMIT 1`
      )
    ).rows[0]!;

    try {
      await bypassingTriggers((c) =>
        c
          .query(`DELETE FROM ledger_checkpoints WHERE id = $1::bigint`, [mid.id])
          .then(() => undefined)
      );
      const inv = await runInvariants();
      expect(inv.ok).toBe(false);
      expect(inv.output).toMatch(/\[7\] hash-chain/);
    } finally {
      // Reinserta el checkpoint EXACTO (mismo id/hashes/ts) bajo replica.
      await bypassingTriggers((c) =>
        c
          .query(
            `INSERT INTO ledger_checkpoints
               (id, upto_seq, entry_count, segment_hash, prev_chain_hash, chain_hash, sealed_at)
             OVERRIDING SYSTEM VALUE VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (id) DO NOTHING`,
            [
              mid.id,
              mid.upto_seq,
              mid.entry_count,
              mid.segment_hash,
              mid.prev_chain_hash,
              mid.chain_hash,
              mid.sealed_at,
            ]
          )
          .then(() => undefined)
      ).catch(() => undefined);
    }
    const repaired = await runInvariants();
    expect(repaired.ok).toBe(true);
  }, 40_000);

  it('tampering a SEALED checkpoint (chain_hash) breaks the chain (the chain protects itself)', async () => {
    await insertBalancedTx(29_000);
    const maxSeq = await currentMaxSeq();
    await sealUntilCovers(maxSeq);

    const cp = (
      await ctx.admin.query<{ id: string; chain_hash: string }>(
        `SELECT id::text, chain_hash FROM ledger_checkpoints ORDER BY upto_seq ASC LIMIT 1`
      )
    ).rows[0]!;

    try {
      await bypassingTriggers((c) =>
        c
          .query(
            `UPDATE ledger_checkpoints SET chain_hash = repeat('0', 64) WHERE id = $1::bigint`,
            [cp.id]
          )
          .then(() => undefined)
      );
      const inv = await runInvariants();
      expect(inv.ok).toBe(false);
      expect(inv.output).toMatch(/\[7\] hash-chain/);
    } finally {
      await bypassingTriggers((c) =>
        c
          .query(`UPDATE ledger_checkpoints SET chain_hash = $2 WHERE id = $1::bigint`, [
            cp.id,
            cp.chain_hash,
          ])
          .then(() => undefined)
      ).catch(() => undefined);
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
    await insertBalancedTx(31_000);
    await sealUntilCovers(await currentMaxSeq());
    await expect(ctx.admin.query(`DELETE FROM ledger_checkpoints`)).rejects.toThrow(
      /FLUVIA_IMMUTABLE/
    );
    await expect(ctx.admin.query(`UPDATE ledger_checkpoints SET entry_count = 0`)).rejects.toThrow(
      /FLUVIA_IMMUTABLE/
    );
  }, 30_000);

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
