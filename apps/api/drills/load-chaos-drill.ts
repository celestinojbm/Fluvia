/**
 * DRILL · Carga + Caos de resiliencia del ledger (F6 · load-soak-chaos)
 *
 * Ensaya la RESILIENCIA del motor de dinero bajo carga alta y fallo abrupto,
 * contra un stack REAL (Postgres, rol `fluvia_app` de privilegio mínimo). No es
 * un test unitario: es la rehearsal de caos que complementa a los drills
 * worker-down y restore.
 *
 * A diferencia de `concurrency.test.ts` (que prueba la CORRECCIÓN de la
 * contención feliz a nivel de servicio), este drill ATACA las redes de seguridad
 * de V2-R1 (pool acotado + cotas de tiempo por tx + reintento) inyectando fallo:
 *
 *   PASO 1 — Saturación de pool: N postings concurrentes MUY por encima del `max`
 *     del pool (4). El exceso se encola; se prueba que TODOS drenan sin cuelgue y
 *     con conservación exacta (el pool no deadlockea ni pierde trabajo).
 *   PASO 2 — Caos de conexión: se MATAN backends `fluvia_app` EN VUELO
 *     (`pg_terminate_backend`) mientras llueven postings. Se prueba la ATOMICIDAD:
 *     un posting cuya conexión muere aborta LIMPIO (rollback — el trigger de
 *     balanceo diferido garantiza todo-o-nada), sin asientos huérfanos ni dinero
 *     perdido/creado; el pool se recupera solo (node-pg descarta la conexión
 *     muerta). Algunos postings fallan: se ESPERA bajo caos — lo que NO se admite
 *     es drift.
 *   PASO 3 — Idempotencia bajo caos: M claves × K dups concurrentes DURANTE más
 *     kills. La unicidad la impone la BD (`ON CONFLICT DO NOTHING`), así que ni
 *     con conexiones muriendo se aplica una clave dos veces (a lo sumo una).
 *   PASO 4 — Invariantes finales: conservación por (tx, moneda) + proyección ==
 *     recomputo para TODAS las cuentas del tenant (drift == 0).
 *
 * HONESTIDAD (V4 Nivel A): el throughput que se loguea es una medición del
 * SANDBOX mono-instancia (Postgres local, un pool de 4) — NO es un SLO de
 * producción ni una afirmación de escala. El valor del drill es la INTEGRIDAD del
 * dinero bajo fallo, medida de verdad, no un número de rendimiento.
 *
 * Uso: `pnpm --filter @fluvia/api run drill:load-chaos` (requiere Postgres
 * migrado). Sale 0 en PASS, 1 en FAIL.
 */
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@fluvia/config';
import { createPool, type Pool } from '@fluvia/db';
import { LedgerService } from '@fluvia/ledger';
import { Money } from '@fluvia/money';

const CURRENCY = 'USD';
const POOL_MAX = 4; // pool acotado A PROPÓSITO: satura con concurrencia modesta.

let step = 0;
const log = (msg: string): void => console.log(`  ${msg}`);
function ok(msg: string): void {
  console.log(`\x1b[32m✓\x1b[0m PASO ${++step}: ${msg}`);
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FALLÓ: ${msg}`);
}

/** Mata los backends `fluvia_app` EN VUELO (no el nuestro). Devuelve cuántos. */
async function killAppBackends(admin: Pool): Promise<number> {
  const res = await admin.query<{ pg_terminate_backend: boolean }>(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
     WHERE usename = 'fluvia_app' AND state = 'active' AND pid <> pg_backend_pid()`
  );
  return res.rowCount ?? 0;
}

/** Conservación del tenant + proyección == recomputo para TODAS las cuentas. */
async function assertConsistent(
  admin: Pool,
  ledger: LedgerService,
  org: string,
  accounts: string[]
): Promise<void> {
  const unbalanced = await admin.query(
    `SELECT tx_root_id FROM ledger_entries WHERE tenant_id = $1
     GROUP BY tx_root_id, currency
     HAVING SUM(CASE WHEN direction = 'debit' THEN amount ELSE -amount END) <> 0`,
    [org]
  );
  assert(
    unbalanced.rows.length === 0,
    'toda (tx, moneda) del tenant balancea (sin asiento huérfano)'
  );
  for (const accountId of accounts) {
    const check = await ledger.verifyProjection(org, accountId);
    assert(check.matches, `drift en ${accountId.slice(0, 8)}…: ${JSON.stringify(check)}`);
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const admin = createPool({ connectionString: config.db.admin, max: 6 });
  const app = createPool({ connectionString: config.db.app, max: POOL_MAX });
  const ledger = new LedgerService(app);
  const usd = (n: number): Money => Money.of(n, CURRENCY);

  try {
    // ── Setup: tenant + 6 cuentas ─────────────────────────────────────────────
    const org = (
      await admin.query<{ id: string }>(
        'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id',
        ['Load-Chaos Drill Org', `drill-${randomUUID()}`]
      )
    ).rows[0]!.id;
    const accounts: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const a = await ledger.createAccount({
        tenantId: org,
        name: `lc.${i}`,
        currency: CURRENCY,
        normalSide: i % 2 === 0 ? 'debit' : 'credit',
      });
      accounts.push(a.id);
    }
    const post = (from: string, to: string, amt: number, idem: string): Promise<unknown> =>
      ledger.postTransaction({
        tenantId: org,
        idempotencyKey: idem,
        reason: 'transfer',
        source: { type: 'load', id: idem },
        entries: [
          { accountId: from, direction: 'debit', amount: usd(amt) },
          { accountId: to, direction: 'credit', amount: usd(amt) },
        ],
      });
    log(`org=${org.slice(0, 8)}… · 6 cuentas · pool fluvia_app max=${POOL_MAX}`);

    // ── PASO 1: saturación de pool (concurrencia >> max) ──────────────────────
    const N = 80;
    const t0 = Date.now();
    const r1 = await Promise.allSettled(
      Array.from({ length: N }, (_, i) =>
        post(accounts[i % 6]!, accounts[(i + 1) % 6]!, 1 + i, `sat-${i}-${randomUUID()}`)
      )
    );
    const ms1 = Math.max(1, Date.now() - t0);
    const ok1 = r1.filter((r) => r.status === 'fulfilled').length;
    assert(
      ok1 === N,
      `los ${N} postings con pool max=${POOL_MAX} completan TODOS (sin cuelgue): ${ok1}/${N}`
    );
    await assertConsistent(admin, ledger, org, accounts);
    log(
      `throughput MEDIDO: ${Math.round((N / ms1) * 1000)} tx/s (sandbox mono-instancia, pool=${POOL_MAX} — NO es un SLO de producción)`
    );
    ok(
      `saturación de pool: ${N} postings concurrentes sobre ${POOL_MAX} conexiones drenan sin cuelgue, conservación exacta`
    );

    // ── PASO 2: caos — kill de backends fluvia_app EN VUELO ───────────────────
    let killed = 0;
    const chaos1 = (async () => {
      for (let i = 0; i < 10; i += 1) {
        await new Promise((r) => setTimeout(r, 35));
        killed += await killAppBackends(admin);
      }
    })();
    const r2 = await Promise.allSettled(
      Array.from({ length: 60 }, (_, i) =>
        post(accounts[i % 6]!, accounts[(i + 2) % 6]!, 1 + (i % 50), `chaos-${i}-${randomUUID()}`)
      )
    );
    await chaos1;
    const ok2 = r2.filter((r) => r.status === 'fulfilled').length;
    // Bajo caos algunos postings fallan (su conexión murió, error NO reintentable):
    // se ESPERA. La invariante es que NINGUNO quede a medias — atomicidad.
    await assertConsistent(admin, ledger, org, accounts);
    assert(killed > 0, `el caos realmente mató backends en vuelo (killed=${killed})`);
    ok(
      `caos de conexión: ${killed} backends fluvia_app terminados EN VUELO; ${ok2}/60 ok, ${60 - ok2} fallaron LIMPIO (rollback), CERO drift ni asiento huérfano — atomicidad preservada`
    );

    // ── PASO 3: idempotencia bajo caos (M claves × K dups) ────────────────────
    const M = 12;
    const K = 5;
    const jobs: Promise<unknown>[] = [];
    for (let m = 0; m < M; m += 1) {
      const idem = `idem-${m}-${randomUUID()}`;
      for (let k = 0; k < K; k += 1) {
        jobs.push(post(accounts[2]!, accounts[3]!, 100, idem).catch(() => undefined));
      }
    }
    const chaos2 = (async () => {
      for (let i = 0; i < 6; i += 1) {
        await new Promise((r) => setTimeout(r, 45));
        await killAppBackends(admin);
      }
    })();
    await Promise.all(jobs);
    await chaos2;
    // La BD impone unicidad por clave (ON CONFLICT DO NOTHING): ni con conexiones
    // muriendo se aplica una clave DOS veces. Se verifica en la BD, no en memoria.
    const dup = await admin.query<{ idempotency_key: string; n: string }>(
      `SELECT idempotency_key, COUNT(*)::text AS n FROM ledger_transactions
       WHERE tenant_id = $1 AND idempotency_key LIKE 'idem-%'
       GROUP BY idempotency_key HAVING COUNT(*) > 1`,
      [org]
    );
    assert(
      dup.rows.length === 0,
      `ninguna clave idempotente se aplicó dos veces (dups: ${dup.rows.length})`
    );
    const appliedKeys = Number(
      (
        await admin.query<{ n: string }>(
          `SELECT COUNT(DISTINCT idempotency_key)::text AS n FROM ledger_transactions
           WHERE tenant_id = $1 AND idempotency_key LIKE 'idem-%'`,
          [org]
        )
      ).rows[0]!.n
    );
    await assertConsistent(admin, ledger, org, accounts);
    ok(
      `idempotencia bajo caos: ${M} claves × ${K} dups concurrentes con kills → cada clave aplicada A LO SUMO una vez (${appliedKeys}/${M} aplicadas), sin doble efecto`
    );

    // ── PASO 4: invariantes finales sobre el tenant ───────────────────────────
    await assertConsistent(admin, ledger, org, accounts);
    const totals = await admin.query<{ dr: string; cr: string }>(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE direction='debit'),0)::text AS dr,
              COALESCE(SUM(amount) FILTER (WHERE direction='credit'),0)::text AS cr
       FROM ledger_entries WHERE tenant_id = $1 AND currency = $2`,
      [org, CURRENCY]
    );
    assert(
      totals.rows[0]!.dr === totals.rows[0]!.cr,
      `Σdébitos == Σcréditos del tenant (${totals.rows[0]!.dr} vs ${totals.rows[0]!.cr})`
    );
    ok(
      'invariantes finales: Σdébitos == Σcréditos + proyección == recomputo en las 6 cuentas (drift == 0)'
    );

    console.log(
      `\n\x1b[32m✅ DRILL PASS\x1b[0m — carga+caos ensayados: saturación de pool, kill de conexión en vuelo e idempotencia bajo caos; la INTEGRIDAD del dinero sobrevive al fallo abrupto (${step} pasos).`
    );
    await Promise.all([admin.end(), app.end()]);
    process.exit(0);
  } catch (err) {
    console.error(`\n\x1b[31m❌ DRILL FAIL\x1b[0m en el paso ${step + 1}:`, (err as Error).message);
    await Promise.all([admin.end(), app.end()]).catch(() => {});
    process.exit(1);
  }
}

void main();
