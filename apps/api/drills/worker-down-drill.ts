/**
 * DRILL · Runbook «Worker caído o watcher detenido» (F4-06b)
 *
 * Ensaya el runbook `docs/ops/runbooks/worker-down.md` de punta a punta contra un
 * stack REAL (Postgres, roles con privilegio mínimo). No es un test unitario: es
 * la rehearsal operativa que exige el criterio de salida de la Fase 4.
 *
 * `apps/worker` es la RED DE SEGURIDAD: si el proceso muere, se acumulan
 * silenciosamente backlogs (outbox/inbox sin despachar) y riesgos (drift sin
 * detectar). El runbook: reiniciar → los backlogs se DRENAN solos → verificar el
 * daño acumulado (drift primero, SEV-1). El drill simula la caída sembrando un
 * backlog + un drift, y ensaya la recuperación:
 *   1. Reinicio: `checkReady` (SELECT 1) responde — la BD es accesible.
 *   2. El relay del outbox drena su backlog (los eventos pendientes → delivered).
 *   3. El processor del inbox drena su backlog (pendientes → processed).
 *   4. El drift watcher DETECTA el drift que se acumuló durante la caída.
 *   5. La reparación es EXPLÍCITA (rebuildProjection), jamás automática; tras
 *      repararla, el watcher queda limpio.
 *
 * Uso: `pnpm --filter @fluvia/api run drill:worker-down` (requiere Postgres
 * migrado; ver `docs/ops/runbooks/README.md` §Drill). Sale 0 en PASS, 1 en FAIL.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { loadConfig } from '@fluvia/config';
import { createPool } from '@fluvia/db';
import { buildEnvelope } from '@fluvia/events';
import { InboxProcessor } from '@fluvia/inbox';
import { accountName, LedgerService, PostingService } from '@fluvia/ledger';
import { Money } from '@fluvia/money';
import { OutboxRelay } from '@fluvia/outbox';
import { ProjectionDriftWatcher } from '@fluvia/ledger';

const CURRENCY = 'COP';
const BACKLOG = 3; // eventos de outbox que se acumularon durante la caída

let step = 0;
const log = (msg: string): void => console.log(`  ${msg}`);
function ok(msg: string): void {
  console.log(`\x1b[32m✓\x1b[0m PASO ${++step}: ${msg}`);
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FALLÓ: ${msg}`);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const adminPool = createPool({ connectionString: config.db.admin, max: 4 });
  const appPool = createPool({ connectionString: config.db.app, max: 4 });
  const relayPool = createPool({ connectionString: config.db.relay, max: 2 });
  const inboxPool = createPool({ connectionString: config.db.inbox, max: 2 });
  const workerPool = createPool({ connectionString: config.db.worker, max: 2 });
  const ledger = new LedgerService(appPool);
  const posting = new PostingService(ledger, appPool);
  const relay = new OutboxRelay(
    relayPool,
    { publish: async () => undefined },
    {
      workerId: 'drill-worker-down',
      batchSize: 50,
    }
  );
  const inbox = new InboxProcessor(inboxPool, { batchSize: 50 });
  inbox.register('drilltest', {
    schema: z.object({ marker: z.string() }),
    handler: async () => ({ outcome: 'applied' as const }),
  });
  const driftWatcher = new ProjectionDriftWatcher(workerPool);

  try {
    const org = (
      await adminPool.query<{ id: string }>(
        'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id',
        ['Worker-Down Drill Org', `drill-${randomUUID()}`]
      )
    ).rows[0]!.id;
    const merchant = (
      await adminPool.query<{ id: string }>(
        'INSERT INTO merchants (tenant_id, name) VALUES ($1, $2) RETURNING id',
        [org, `drill-shop-${randomUUID().slice(0, 8)}`]
      )
    ).rows[0]!.id;

    // ── Simular la CAÍDA: sembrar backlog (outbox + inbox) + un saldo real ────
    const outIds: string[] = [];
    for (let i = 0; i < BACKLOG; i += 1) {
      const envelope = buildEnvelope({
        producer: 'fluvia.drill',
        resource: { type: 'drill_resource', id: randomUUID() },
        data: { marker: randomUUID() },
      });
      const id = (
        await adminPool.query<{ id: string }>(
          `INSERT INTO outbox_events (tenant_id, topic, payload)
           VALUES ($1, 'test.event', $2) RETURNING id::text AS id`,
          [org, JSON.stringify(envelope)]
        )
      ).rows[0]!.id;
      outIds.push(id);
    }
    const inId = (
      await adminPool.query<{ id: string }>(
        `INSERT INTO provider_events
           (provider, provider_event_id, event_type, raw_body, headers, signature_verified, status)
         VALUES ('drilltest', $1, 'drill.event', $2, '{}'::jsonb, true, 'pending')
         RETURNING id::text AS id`,
        [`drill_${randomUUID()}`, JSON.stringify({ marker: 'x' })]
      )
    ).rows[0]!.id;
    // Un saldo real (captura) para poder tamperear su proyección y simular drift.
    const src = randomUUID();
    await posting.capturePayment({
      tenantId: org,
      merchantId: merchant,
      idempotencyKey: `cap:${src}`,
      sourceType: 'payment_attempt',
      sourceId: src,
      amount: Money.of(80_000, CURRENCY),
    });
    const acctId = (
      await adminPool.query<{ id: string }>(
        `SELECT id FROM ledger_accounts WHERE tenant_id=$1 AND name=$2 AND currency=$3 AND deleted_at IS NULL`,
        [org, accountName('merchant.pending', merchant), CURRENCY]
      )
    ).rows[0]!.id;
    log(
      `org=${org.slice(0, 8)}… · backlog outbox=${BACKLOG} + inbox=1 · cuenta=${acctId.slice(0, 8)}…`
    );

    // ── PASO 1: reinicio — checkReady (SELECT 1) responde ─────────────────────
    const ready = await workerPool.query<{ ok: number }>(`SELECT 1 AS ok`);
    assert(ready.rows[0]!.ok === 1, 'checkReady: SELECT 1 responde (BD accesible)');
    ok('el worker reinicia: `checkReady` (SELECT 1) responde — la BD es accesible');

    // ── PASO 2: el relay del outbox DRENA su backlog → delivered ──────────────
    for (let i = 0; i < 50; i += 1) {
      const stats = await relay.runOnce();
      if (stats.claimed === 0 && stats.dead === 0) break;
    }
    const outDrained = await adminPool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM outbox_events WHERE id = ANY($1::bigint[]) AND status='delivered'`,
      [outIds]
    );
    assert(
      Number(outDrained.rows[0]!.n) === BACKLOG,
      `los ${BACKLOG} eventos de outbox se drenaron (delivered)`
    );
    ok(`el relay retomó el backlog de outbox y lo drenó solo: ${BACKLOG}/${BACKLOG} delivered`);

    // ── PASO 3: el processor del inbox DRENA su backlog → processed ───────────
    let inDrained = false;
    for (let i = 0; i < 50; i += 1) {
      await inbox.runOnce();
      const s = (
        await adminPool.query<{ status: string }>(
          `SELECT status FROM provider_events WHERE id=$1`,
          [inId]
        )
      ).rows[0]!.status;
      if (s === 'processed') {
        inDrained = true;
        break;
      }
      if (s !== 'pending') break;
    }
    assert(inDrained, 'el evento de inbox del backlog se drenó (processed)');
    ok('el processor del inbox retomó su backlog y lo drenó solo: processed');

    // ── PASO 4: el drift watcher DETECTA el drift acumulado durante la caída ───
    // Simula la corrupción de proyección que se acumuló sin vigilancia.
    await adminPool.query(
      `UPDATE balance_projections SET available = available + 123 WHERE account_id=$1`,
      [acctId]
    );
    const drifted = await driftWatcher.runOnce();
    assert(
      drifted.some((r) => r.accountId === acctId),
      'el drift watcher detecta la cuenta con drift'
    );
    ok('el drift watcher DETECTA el drift acumulado durante la caída (gauge en alerta — SEV-1)');

    // ── PASO 5: reparación EXPLÍCITA (jamás automática) → watcher limpio ───────
    await ledger.rebuildProjection(org, acctId);
    const clean = await driftWatcher.runOnce();
    assert(
      !clean.some((r) => r.accountId === acctId),
      'tras rebuildProjection, la cuenta ya no aparece con drift'
    );
    ok(
      'reparación EXPLÍCITA `rebuildProjection` (nunca automática, V4 §30) → el watcher queda limpio'
    );

    console.log(
      `\n\x1b[32m✅ DRILL PASS\x1b[0m — runbook worker-down ensayado end-to-end (reinicio → drena backlog → detecta+repara drift) (${step} pasos).`
    );
    await Promise.all([
      adminPool.end(),
      appPool.end(),
      relayPool.end(),
      inboxPool.end(),
      workerPool.end(),
    ]);
    process.exit(0);
  } catch (err) {
    console.error(`\n\x1b[31m❌ DRILL FAIL\x1b[0m en el paso ${step + 1}:`, (err as Error).message);
    await Promise.all([
      adminPool.end(),
      appPool.end(),
      relayPool.end(),
      inboxPool.end(),
      workerPool.end(),
    ]).catch(() => {});
    process.exit(1);
  }
}

void main();
