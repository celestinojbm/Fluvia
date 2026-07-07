/**
 * DRILL · Runbook «Eventos `dead` en outbox / inbox» (F4-06b)
 *
 * Ensaya el runbook `docs/ops/runbooks/outbox-inbox-stuck.md` de punta a punta
 * contra un stack REAL (Postgres, roles con privilegio mínimo). No es un test
 * unitario: es la rehearsal operativa que exige el criterio de salida de la
 * Fase 4 («runbooks probados en drill»).
 *
 * El único camino sancionado para corregir un evento `dead` es el REPLAY
 * AUDITADO sobre el admin pool (ADR-0011): el relay (`fluvia_relay`) y el
 * procesador de inbox (`fluvia_inbox`) tienen privilegio mínimo y NO pueden
 * hacer `dead → pending`. El drill lo prueba en las dos direcciones:
 *   - OUTBOX (salida): `replayDeadOutboxEvents` re-encola un evento de dominio
 *     `dead` y el relay lo entrega.
 *   - INBOX (entrada): `replayDeadProviderEvents` re-encola un evento de
 *     proveedor `dead` y el processor lo procesa.
 * En ambos: `reason` es OBLIGATORIA (sin reason → rechazado; no hay corrección
 * silenciosa), el replay queda auditado como `platform.operation` en la MISMA
 * transacción, y es idempotente (solo actúa sobre filas `dead`).
 *
 * Uso: `pnpm --filter @fluvia/api run drill:outbox-inbox` (requiere Postgres
 * migrado; ver `docs/ops/runbooks/README.md` §Drill). Sale 0 en PASS, 1 en FAIL.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PlatformReasonRequiredError } from '@fluvia/audit';
import { loadConfig } from '@fluvia/config';
import { createPool } from '@fluvia/db';
import { buildEnvelope } from '@fluvia/events';
import { InboxProcessor, replayDeadProviderEvents } from '@fluvia/inbox';
import { OutboxRelay, replayDeadOutboxEvents } from '@fluvia/outbox';

let step = 0;
const log = (msg: string): void => console.log(`  ${msg}`);
function ok(msg: string): void {
  console.log(`\x1b[32m✓\x1b[0m PASO ${++step}: ${msg}`);
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FALLÓ: ${msg}`);
}

async function main(): Promise<void> {
  const config = loadConfig(); // NODE_ENV=local + *_DATABASE_URL del entorno
  const adminPool = createPool({ connectionString: config.db.admin, max: 4 });
  const relayPool = createPool({ connectionString: config.db.relay, max: 2 });
  const inboxPool = createPool({ connectionString: config.db.inbox, max: 2 });
  // Publisher no-op: el relay marca `delivered` cuando publish() resuelve (el
  // fan-out real a webhooks lo cubre delivery.test.ts; aquí probamos el replay).
  const relay = new OutboxRelay(
    relayPool,
    { publish: async () => undefined },
    {
      workerId: 'drill-outbox',
      batchSize: 50,
    }
  );

  try {
    const org = (
      await adminPool.query<{ id: string }>(
        'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id',
        ['Outbox-Inbox Drill Org', `drill-${randomUUID()}`]
      )
    ).rows[0]!.id;
    log(`org=${org.slice(0, 8)}…`);

    // ══ OUTBOX (evento de dominio saliente) ═══════════════════════════════════
    // Siembra un evento válido y lo fuerza a `dead` (reintentos agotados).
    const envelope = buildEnvelope({
      producer: 'fluvia.drill',
      resource: { type: 'drill_resource', id: randomUUID() },
      data: { marker: randomUUID() },
    });
    const outId = (
      await adminPool.query<{ id: string }>(
        `INSERT INTO outbox_events (tenant_id, topic, payload)
         VALUES ($1, 'test.event', $2) RETURNING id::text AS id`,
        [org, JSON.stringify(envelope)]
      )
    ).rows[0]!.id;
    await adminPool.query(
      `UPDATE outbox_events SET status='dead', attempts=8, last_error='drill: retries exhausted' WHERE id=$1`,
      [outId]
    );

    // PASO 1: el replay EXIGE reason — sin reason no hay dead→pending por fuera.
    let outGuarded = false;
    try {
      await replayDeadOutboxEvents(adminPool, { eventIds: [outId], reason: '  ' });
    } catch (err) {
      outGuarded = err instanceof PlatformReasonRequiredError;
    }
    assert(outGuarded, 'replay outbox sin reason → PlatformReasonRequiredError');
    ok('outbox: el replay EXIGE `reason` (sin reason → rechazado; no hay corrección silenciosa)');

    // PASO 2: replay auditado dead→pending (solo el admin pool puede).
    const outReq = `drill-out-${randomUUID().slice(0, 8)}`;
    const outReplayed = await replayDeadOutboxEvents(adminPool, {
      eventIds: [outId],
      reason: 'drill: causa raíz corregida, re-encolar',
      requestId: outReq,
    });
    assert(outReplayed.includes(outId), 'replay devolvió el id re-encolado');
    const outRow = (
      await adminPool.query<{ status: string; attempts: string; last_error: string | null }>(
        `SELECT status, attempts::text, last_error FROM outbox_events WHERE id=$1`,
        [outId]
      )
    ).rows[0]!;
    assert(
      outRow.status === 'pending' && Number(outRow.attempts) === 0 && outRow.last_error === null,
      'outbox dead→pending (attempts=0, last_error NULL)'
    );
    ok('outbox: replay auditado dead→pending (attempts=0)');

    // PASO 3: rastro de auditoría `platform.operation` con reason + replayed_ids.
    const outAudit = await adminPool.query<{
      reason: string;
      after_summary: { replayed_ids?: string[] };
    }>(
      `SELECT reason, after_summary FROM audit_events
        WHERE action='platform.operation' AND resource_type='outbox_event' AND request_id=$1`,
      [outReq]
    );
    assert(outAudit.rowCount === 1, '1 fila platform.operation (outbox)');
    assert(
      Array.isArray(outAudit.rows[0]!.after_summary.replayed_ids) &&
        outAudit.rows[0]!.after_summary.replayed_ids!.includes(outId),
      'after_summary.replayed_ids incluye el id'
    );
    ok('outbox: `platform.operation` auditado (reason + replayed_ids)');

    // PASO 4: el relay retoma el evento re-encolado → delivered.
    let outDelivered = false;
    for (let i = 0; i < 50; i += 1) {
      await relay.runOnce();
      const s = (
        await adminPool.query<{ status: string }>(`SELECT status FROM outbox_events WHERE id=$1`, [
          outId,
        ])
      ).rows[0]!.status;
      if (s === 'delivered') {
        outDelivered = true;
        break;
      }
      if (s !== 'pending') break;
    }
    assert(outDelivered, 'tras el replay, el relay entrega el evento (delivered)');
    // Idempotencia: replay de un id NO-dead (ya delivered) es no-op.
    const outAgain = await replayDeadOutboxEvents(adminPool, {
      eventIds: [outId],
      reason: 'drill: reintento (debe ser no-op)',
    });
    assert(outAgain.length === 0, 'replay de un id no-dead es no-op (solo actúa sobre dead)');
    ok(
      'outbox: el relay retomó el re-encolado → delivered; replay solo actúa sobre dead (idempotente)'
    );

    // ══ INBOX (evento de proveedor entrante) ══════════════════════════════════
    const inbox = new InboxProcessor(inboxPool, { batchSize: 50 });
    inbox.register('drilltest', {
      schema: z.object({ marker: z.string() }),
      handler: async () => ({ outcome: 'applied' as const }),
    });
    // Siembra un evento de proveedor `dead` cuyo payload casa con el schema
    // registrado (así, tras corregir la causa, el replay → processed).
    const inId = (
      await adminPool.query<{ id: string }>(
        `INSERT INTO provider_events
           (provider, provider_event_id, event_type, raw_body, headers, signature_verified, status, attempts, last_error)
         VALUES ('drilltest', $1, 'drill.event', $2, '{}'::jsonb, true, 'dead', 8, 'drill: exhausted')
         RETURNING id::text AS id`,
        [`drill_${randomUUID()}`, JSON.stringify({ marker: 'x' })]
      )
    ).rows[0]!.id;

    // PASO 5: EXIGE reason + replay auditado dead→pending (limpia result/processed_at).
    let inGuarded = false;
    try {
      await replayDeadProviderEvents(adminPool, { eventIds: [inId], reason: '' });
    } catch (err) {
      inGuarded = err instanceof PlatformReasonRequiredError;
    }
    assert(inGuarded, 'replay inbox sin reason → PlatformReasonRequiredError');
    const inReq = `drill-in-${randomUUID().slice(0, 8)}`;
    const inReplayed = await replayDeadProviderEvents(adminPool, {
      eventIds: [inId],
      reason: 'drill: schema corregido, reprocesar',
      requestId: inReq,
    });
    assert(inReplayed.includes(inId), 'replay inbox devolvió el id');
    const inRow = (
      await adminPool.query<{ status: string; result: string | null; processed_at: Date | null }>(
        `SELECT status, result, processed_at FROM provider_events WHERE id=$1`,
        [inId]
      )
    ).rows[0]!;
    assert(
      inRow.status === 'pending' && inRow.result === null && inRow.processed_at === null,
      'inbox dead→pending (result/processed_at NULL)'
    );
    ok('inbox: el replay EXIGE `reason`; auditado dead→pending (limpia result/processed_at)');

    // PASO 6: rastro de auditoría `platform.operation` (provider_event).
    const inAudit = await adminPool.query(
      `SELECT 1 FROM audit_events
        WHERE action='platform.operation' AND resource_type='provider_event' AND request_id=$1`,
      [inReq]
    );
    assert(inAudit.rowCount === 1, '1 fila platform.operation (inbox)');
    ok('inbox: `platform.operation` auditado');

    // PASO 7: el processor retoma el evento → processed (result=applied).
    let inProcessed = false;
    for (let i = 0; i < 50; i += 1) {
      await inbox.runOnce();
      const s = (
        await adminPool.query<{ status: string; result: string | null }>(
          `SELECT status, result FROM provider_events WHERE id=$1`,
          [inId]
        )
      ).rows[0]!;
      if (s.status === 'processed') {
        inProcessed = s.result === 'applied';
        break;
      }
      if (s.status !== 'pending') break;
    }
    assert(inProcessed, 'tras el replay, el inbox procesa el evento (processed, result=applied)');
    // Idempotencia: replay de un provider_event NO-dead (processed) es no-op.
    const inAgain = await replayDeadProviderEvents(adminPool, {
      eventIds: [inId],
      reason: 'drill: reintento (no-op)',
    });
    assert(inAgain.length === 0, 'replay de un provider_event no-dead es no-op');
    ok(
      'inbox: el processor retomó el re-encolado → processed; replay solo actúa sobre dead (idempotente)'
    );

    console.log(
      `\n\x1b[32m✅ DRILL PASS\x1b[0m — runbook outbox-inbox-stuck ensayado end-to-end (replay auditado outbox + inbox) (${step} pasos).`
    );
    await Promise.all([adminPool.end(), relayPool.end(), inboxPool.end()]);
    process.exit(0);
  } catch (err) {
    console.error(`\n\x1b[31m❌ DRILL FAIL\x1b[0m en el paso ${step + 1}:`, (err as Error).message);
    await Promise.all([adminPool.end(), relayPool.end(), inboxPool.end()]).catch(() => {});
    process.exit(1);
  }
}

void main();
