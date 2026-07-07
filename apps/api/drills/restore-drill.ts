/**
 * DRILL · Runbook «Restore de backup» (F6 — Gate Restore, cierra la pata restante
 * de AUD-P2-007).
 *
 * Ensaya el runbook `docs/ops/runbooks/backup-restore.md` de punta a punta contra
 * un Postgres 16 REAL. No es un test unitario: es la rehearsal operativa que exige
 * el criterio de la Fase 6 (`production-gates.md` §Gate Restore):
 *   «Backup restaurado + ledger verificado + proyecciones reconstruidas +
 *    conciliación post-restore».
 *
 * El drill:
 *   1. Siembra un estado contable CONOCIDO (captura de $X → asientos + proyección)
 *      y toma un snapshot de la fuente (conteos + Σamount + saldo del marcador);
 *      la fuente pasa `FLUVIA_INVARIANTS_OK` (sanity previo).
 *   2. Backup lógico con `pg_dump -Fc` a un archivo; el `pg_restore --list` prueba
 *      que el archivo es legible/íntegro.
 *   3. Restore en una base FRESCA (`fluvia_restore_drill`) con `pg_restore
 *      --exit-on-error` y `code === 0` ASSERTEADO — un restore PARCIAL no puede pasar
 *      como verde; sin tocar la fuente.
 *   4. Ledger verificado sobre la COPIA: `verify-ledger-invariants.sql` →
 *      `FLUVIA_INVARIANTS_OK` (el objetivo AUD-P2-012/F2-06: auditar la copia SIN
 *      pasar por el código de la app).
 *   5. Paridad fuente↔copia (RPO = 0 para un backup lógico consistente): conteos de
 *      `ledger_entries`/`ledger_accounts`/`balance_projections`/`ledger_transactions`
 *      + Σamount + saldo del marcador, Y **checksums row-level** (`md5(string_agg(
 *      row::text ORDER BY id))`) de asientos y transacciones — detectan pérdida de
 *      filas o corrupción de valores que preservaría los agregados.
 *   6. Proyecciones RECONSTRUIBLES sobre la copia: se tamperea una proyección en la
 *      copia (drift) → `LedgerService.rebuildProjection` (reparación EXPLÍCITA, con
 *      el rol `fluvia_app` de mínimo privilegio contra la copia) → invariantes verdes
 *      de nuevo. La app OPERA sobre la copia restaurada.
 *   7. Postura de seguridad preservada: la copia conserva RLS FORZADO + políticas en
 *      las tablas core — el backup preserva el AISLAMIENTO, no solo los datos.
 *
 * Uso: `pnpm --filter @fluvia/api run drill:restore` (requiere Postgres migrado y
 * las herramientas cliente `pg_dump`/`pg_restore`/`psql`; ver `runbooks/README.md`
 * §Drill). Sale 0 en PASS, 1 en FAIL. Limpia la base de restore al terminar.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@fluvia/config';
import { createPool } from '@fluvia/db';
import { accountName, LedgerService, PostingService } from '@fluvia/ledger';
import { Money } from '@fluvia/money';

const execFileAsync = promisify(execFile);
const CURRENCY = 'COP';
const RESTORE_DB = 'fluvia_restore_drill';
const SEED_AMOUNT = 137_000n; // monto del marcador (unidades menores)

const INVARIANTS_SQL = fileURLToPath(
  new URL('../../../scripts/verify-ledger-invariants.sql', import.meta.url)
);

let step = 0;
const log = (msg: string): void => console.log(`  ${msg}`);
function ok(msg: string): void {
  console.log(`\x1b[32m✓\x1b[0m PASO ${++step}: ${msg}`);
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FALLÓ: ${msg}`);
}

/** Misma URL con otra base (los roles son globales del cluster). */
function withDb(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

/** Ejecuta un binario cliente de PG; nunca lanza — devuelve code/stdout/stderr. */
async function run(
  cmd: string,
  args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      maxBuffer: 128 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof err.code === 'number' ? err.code : 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
    };
  }
}

interface Snapshot {
  entries: string;
  accounts: string;
  projections: string;
  transactions: string;
  sumAmount: string;
  markerAvailable: string;
  entriesHash: string;
  txHash: string;
}
async function snapshot(pool: ReturnType<typeof createPool>, acctId: string): Promise<Snapshot> {
  const q = await pool.query<Snapshot>(
    `SELECT
       (SELECT COUNT(*)::text FROM ledger_entries)                              AS entries,
       (SELECT COUNT(*)::text FROM ledger_accounts)                             AS accounts,
       (SELECT COUNT(*)::text FROM balance_projections)                         AS projections,
       (SELECT COUNT(*)::text FROM ledger_transactions)                         AS transactions,
       (SELECT COALESCE(SUM(amount), 0)::numeric::text FROM ledger_entries)     AS "sumAmount",
       (SELECT available::text FROM balance_projections WHERE account_id = $1)  AS "markerAvailable",
       -- Checksums a nivel de FILA (row::text captura TODAS las columnas): detectan
       -- pérdida de filas o corrupción de valores que preservaría counts+Σ — el
       -- agujero que señaló la revisión adversarial del drill.
       (SELECT md5(COALESCE(string_agg(e::text, ',' ORDER BY e.id), '')) FROM ledger_entries e)      AS "entriesHash",
       (SELECT md5(COALESCE(string_agg(t::text, ',' ORDER BY t.id), '')) FROM ledger_transactions t) AS "txHash"`,
    [acctId]
  );
  return q.rows[0]!;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const adminUrl = config.db.admin;
  const maintenanceUrl = withDb(adminUrl, 'postgres');
  const restoreAdminUrl = withDb(adminUrl, RESTORE_DB);
  const restoreAppUrl = withDb(config.db.app, RESTORE_DB);

  const adminPool = createPool({ connectionString: adminUrl, max: 4 });
  const appPool = createPool({ connectionString: config.db.app, max: 4 });
  const tmp = mkdtempSync(join(tmpdir(), 'fluvia-restore-drill-'));
  const dumpFile = join(tmp, 'fluvia.dump');

  // psql/pg_dump toman la contraseña de la URI; no se imprime en ningún log.
  const dropRestore = async (): Promise<void> => {
    await run('psql', [
      maintenanceUrl,
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      `DROP DATABASE IF EXISTS ${RESTORE_DB} WITH (FORCE)`,
    ]);
  };

  let restoreAppPool: ReturnType<typeof createPool> | undefined;
  try {
    // ── PASO 1: sembrar estado conocido + snapshot fuente + invariantes previos ──
    const org = (
      await adminPool.query<{ id: string }>(
        'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id',
        ['Restore Drill Org', `drill-${randomUUID()}`]
      )
    ).rows[0]!.id;
    const merchant = (
      await adminPool.query<{ id: string }>(
        'INSERT INTO merchants (tenant_id, name) VALUES ($1, $2) RETURNING id',
        [org, `drill-shop-${randomUUID().slice(0, 8)}`]
      )
    ).rows[0]!.id;
    const ledger = new LedgerService(appPool);
    const posting = new PostingService(ledger, appPool);
    const src = randomUUID();
    await posting.capturePayment({
      tenantId: org,
      merchantId: merchant,
      idempotencyKey: `cap:${src}`,
      sourceType: 'payment_attempt',
      sourceId: src,
      amount: Money.of(SEED_AMOUNT, CURRENCY),
    });
    const acctId = (
      await adminPool.query<{ id: string }>(
        `SELECT id FROM ledger_accounts WHERE tenant_id=$1 AND name=$2 AND currency=$3 AND deleted_at IS NULL`,
        [org, accountName('merchant.pending', merchant), CURRENCY]
      )
    ).rows[0]!.id;

    const before = await run('psql', [adminUrl, '-v', 'ON_ERROR_STOP=1', '-f', INVARIANTS_SQL]);
    assert(
      before.code === 0 && /FLUVIA_INVARIANTS_OK/.test(before.stdout + before.stderr),
      'la FUENTE pasa FLUVIA_INVARIANTS_OK antes del backup (sanity)'
    );
    // El snapshot de la fuente y el `pg_dump` (PASO 2) toman instantáneas separadas;
    // el drill asume ser el ÚNICO escritor (como los demás drills, que siembran y
    // asertan sobre un stack controlado). Una escritura concurrente daría un FAIL
    // espurio (nunca un falso-verde), y el operador re-corre el drill.
    const source = await snapshot(adminPool, acctId);
    assert(
      source.markerAvailable === SEED_AMOUNT.toString(),
      'saldo del marcador sembrado correctamente'
    );
    log(
      `org=${org.slice(0, 8)}… · marcador=${acctId.slice(0, 8)}…=${source.markerAvailable} · ` +
        `entries=${source.entries} accounts=${source.accounts} proj=${source.projections}`
    );
    ok('estado contable sembrado + FUENTE con invariantes verdes + snapshot tomado');

    // ── PASO 2: backup lógico (pg_dump -Fc) + verificación de integridad ─────────
    const dump = await run('pg_dump', ['-Fc', '--no-password', '-f', dumpFile, adminUrl]);
    assert(dump.code === 0, `pg_dump completó (code=${dump.code}) ${dump.stderr.slice(0, 200)}`);
    const list = await run('pg_restore', ['--list', dumpFile]);
    assert(
      list.code === 0 &&
        /ledger_entries/.test(list.stdout) &&
        /balance_projections/.test(list.stdout),
      'el archivo de backup es legible e incluye las tablas del ledger (pg_restore --list)'
    );
    ok('backup lógico creado con `pg_dump -Fc`; `pg_restore --list` confirma que es íntegro');

    // ── PASO 3: restore en base FRESCA (sin tocar la fuente) ─────────────────────
    await dropRestore();
    const created = await run('psql', [
      maintenanceUrl,
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      `CREATE DATABASE ${RESTORE_DB}`,
    ]);
    assert(
      created.code === 0,
      `CREATE DATABASE ${RESTORE_DB} (code=${created.code}) ${created.stderr.slice(0, 200)}`
    );
    // `--exit-on-error`: pg_restore ABORTA y sale != 0 al primer fallo (p. ej. un
    // COPY que no carga por completo). Se ASSERTEA `code === 0` — un restore PARCIAL
    // no puede pasar como verde. Descartar este exit code (tratarlo de «warning
    // benigno») era el agujero P2 que señaló la revisión adversarial: se cierra aquí.
    const restore = await run('pg_restore', [
      '--no-password',
      '--exit-on-error',
      '-d',
      restoreAdminUrl,
      dumpFile,
    ]);
    assert(
      restore.code === 0,
      `pg_restore --exit-on-error completó sin errores (code=${restore.code}) ${restore.stderr.slice(0, 300)}`
    );
    const restorePool = createPool({ connectionString: restoreAdminUrl, max: 4 });
    const schemaOk = await restorePool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM information_schema.tables
       WHERE table_schema='public' AND table_name IN ('ledger_entries','ledger_accounts','balance_projections')`
    );
    await restorePool.end();
    assert(schemaOk.rows[0]!.n === '3', 'la copia restaurada tiene las 3 tablas core del ledger');
    ok(
      'restore en `' +
        RESTORE_DB +
        '` sin errores (`pg_restore --exit-on-error` code=0); esquema del ledger presente'
    );

    // ── PASO 4: ledger verificado sobre la COPIA (auditoría fuera del ORM) ────────
    const after = await run('psql', [
      restoreAdminUrl,
      '-v',
      'ON_ERROR_STOP=1',
      '-f',
      INVARIANTS_SQL,
    ]);
    assert(
      after.code === 0 && /FLUVIA_INVARIANTS_OK/.test(after.stdout + after.stderr),
      `la COPIA restaurada pasa FLUVIA_INVARIANTS_OK (code=${after.code}) ${after.stderr.slice(0, 200)}`
    );
    ok('ledger verificado sobre la copia: `verify-ledger-invariants.sql` → `FLUVIA_INVARIANTS_OK`');

    // ── PASO 5: paridad fuente↔copia (RPO = 0 para el backup lógico) ─────────────
    const restoreAdminPool = createPool({ connectionString: restoreAdminUrl, max: 4 });
    const restored = await snapshot(restoreAdminPool, acctId);
    await restoreAdminPool.end();
    assert(
      restored.entries === source.entries,
      `paridad ledger_entries (${source.entries} vs ${restored.entries})`
    );
    assert(
      restored.accounts === source.accounts,
      `paridad ledger_accounts (${source.accounts} vs ${restored.accounts})`
    );
    assert(
      restored.projections === source.projections,
      `paridad balance_projections (${source.projections} vs ${restored.projections})`
    );
    assert(
      restored.transactions === source.transactions,
      `paridad ledger_transactions (${source.transactions} vs ${restored.transactions})`
    );
    assert(
      restored.sumAmount === source.sumAmount,
      `paridad Σamount (${source.sumAmount} vs ${restored.sumAmount})`
    );
    assert(
      restored.markerAvailable === source.markerAvailable,
      `saldo del marcador exacto en la copia (${source.markerAvailable} vs ${restored.markerAvailable})`
    );
    // Checksums row-level: cualquier fila perdida o valor corrupto (aunque preserve
    // counts+Σ) rompe el hash — paridad byte-a-byte del núcleo contable (asientos +
    // transacciones), no solo agregada. Cierra el 2º hallazgo P2 de la revisión.
    assert(
      restored.entriesHash === source.entriesHash,
      `checksum row-level de ledger_entries idéntico (${source.entriesHash} vs ${restored.entriesHash})`
    );
    assert(
      restored.txHash === source.txHash,
      `checksum row-level de ledger_transactions idéntico (${source.txHash} vs ${restored.txHash})`
    );
    ok(
      `paridad fuente↔copia: counts (entries/accounts/projections/transactions) + Σamount + saldo del marcador + checksums row-level de entries y transactions idénticos (RPO=0)`
    );

    // ── PASO 6: proyecciones RECONSTRUIBLES sobre la copia (la app opera) ─────────
    // Tamperea la proyección de la copia (simula corrupción) → rebuild explícito con
    // el rol de mínimo privilegio `fluvia_app` contra la copia → invariantes verdes.
    restoreAppPool = createPool({ connectionString: restoreAppUrl, max: 2 });
    // El `DROP DATABASE ... WITH (FORCE)` del cleanup termina las conexiones idle
    // de este pool; sin este handler, esa terminación emitiría un 'error' no
    // capturado y tumbaría el proceso DESPUÉS del PASS.
    restoreAppPool.on('error', () => {});
    const restoreLedger = new LedgerService(restoreAppPool);
    // Tamperea con un pool admin efímero y query PARAMETRIZADA (el rol `fluvia_app`
    // no puede UPDATE-ar `balance_projections` fuera de una tx con tenant por RLS).
    const tamperPool = createPool({ connectionString: restoreAdminUrl, max: 1 });
    await tamperPool.query(
      `UPDATE balance_projections SET available = available + 999 WHERE account_id = $1`,
      [acctId]
    );
    await tamperPool.end();
    const driftCheck = await run('psql', [
      restoreAdminUrl,
      '-v',
      'ON_ERROR_STOP=1',
      '-f',
      INVARIANTS_SQL,
    ]);
    assert(
      driftCheck.code !== 0 &&
        /FLUVIA_INVARIANT_VIOLATION/.test(driftCheck.stdout + driftCheck.stderr),
      'las invariantes DETECTAN el drift inyectado en la copia (no falso-verde)'
    );
    await restoreLedger.rebuildProjection(org, acctId);
    const repaired = await run('psql', [
      restoreAdminUrl,
      '-v',
      'ON_ERROR_STOP=1',
      '-f',
      INVARIANTS_SQL,
    ]);
    assert(
      repaired.code === 0 && /FLUVIA_INVARIANTS_OK/.test(repaired.stdout + repaired.stderr),
      'tras `rebuildProjection` sobre la copia, las invariantes vuelven a verde'
    );
    ok(
      'proyecciones reconstruibles en la copia: drift detectado → `rebuildProjection` (fluvia_app, explícito) → invariantes verdes'
    );

    // ── PASO 7: la copia preserva la POSTURA DE SEGURIDAD (RLS forzado + políticas) ─
    const secPool = createPool({ connectionString: restoreAdminUrl, max: 2 });
    const forced = await secPool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM pg_class
       WHERE relrowsecurity AND relforcerowsecurity
         AND relname IN ('ledger_entries','ledger_accounts','balance_projections')`
    );
    const policies = await secPool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM pg_policies
       WHERE tablename IN ('ledger_entries','ledger_accounts','balance_projections')`
    );
    await secPool.end();
    assert(forced.rows[0]!.n === '3', 'las 3 tablas core conservan RLS FORZADO en la copia');
    assert(
      Number(policies.rows[0]!.n) >= 3,
      'las políticas RLS por-tenant se restauraron en la copia'
    );
    ok(
      `la copia preserva el AISLAMIENTO: RLS forzado en 3/3 tablas core + ${policies.rows[0]!.n} políticas restauradas`
    );

    console.log(
      `\n\x1b[32m✅ DRILL PASS\x1b[0m — runbook backup-restore ensayado end-to-end ` +
        `(backup → restore → ledger verificado → paridad → proyección reconstruida → RLS preservado) (${step} pasos).`
    );
    // Cierra el pool conectado a la copia ANTES de dropear la base (evita que el
    // servidor termine una conexión viva bajo nuestros pies).
    await restoreAppPool.end();
    await dropRestore();
    await Promise.all([adminPool.end(), appPool.end()]);
    rmSync(tmp, { recursive: true, force: true });
    process.exit(0);
  } catch (err) {
    console.error(`\n\x1b[31m❌ DRILL FAIL\x1b[0m en el paso ${step + 1}:`, (err as Error).message);
    await (restoreAppPool?.end() ?? Promise.resolve()).catch(() => {});
    await dropRestore().catch(() => {});
    await Promise.all([adminPool.end(), appPool.end()]).catch(() => {});
    rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  }
}

void main();
