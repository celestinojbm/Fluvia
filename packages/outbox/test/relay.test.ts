import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '@fluvia/db/testing';
import { PlatformReasonRequiredError } from '@fluvia/audit';
import { buildEnvelope } from '@fluvia/events';
import {
  OutboxRelay,
  computeBackoffMs,
  replayDeadOutboxEvents,
  type ClaimedOutboxEvent,
  type OutboxPublisher,
} from '../src/index.js';

let ctx: TestContext;
let orgA: string;
let orgB: string;

/** Inserta un evento pending valido y devuelve su id. */
async function seedEvent(tenantId: string, data: Record<string, unknown> = {}): Promise<string> {
  const envelope = buildEnvelope({
    producer: 'fluvia.test',
    resource: { type: 'test_resource', id: randomUUID() },
    data: { marker: randomUUID(), ...data },
  });
  const res = await ctx.admin.query<{ id: string }>(
    `INSERT INTO outbox_events (tenant_id, topic, payload)
     VALUES ($1, 'test.event', $2) RETURNING id::text AS id`,
    [tenantId, JSON.stringify(envelope)]
  );
  return res.rows[0]!.id;
}

async function eventRow(id: string) {
  const res = await ctx.admin.query<{
    status: string;
    attempts: number;
    last_error: string | null;
    locked_by: string | null;
    delivered_at: Date | null;
    future_ms: string;
  }>(
    `SELECT status, attempts, last_error, locked_by, delivered_at,
            round(extract(epoch FROM (next_attempt_at - now())) * 1000)::text AS future_ms
     FROM outbox_events WHERE id = $1`,
    [id]
  );
  return res.rows[0]!;
}

function recordingPublisher() {
  const published: ClaimedOutboxEvent[] = [];
  const publisher: OutboxPublisher = {
    async publish(event) {
      published.push(event);
    },
  };
  return { published, publisher };
}

beforeAll(async () => {
  ctx = await createTestContext();
  orgA = await ctx.createTenant('Relay Org A');
  orgB = await ctx.createTenant('Relay Org B');

  // La tabla es append-only y compartida: suites anteriores (ledger/posting)
  // dejan eventos pending. Se drena el backlog para que cada test razone
  // solo sobre lo que siembra (el claim ordena por antiguedad).
  const drain = new OutboxRelay(
    ctx.relay,
    { publish: async () => undefined },
    { workerId: 'w-drain', batchSize: 100 }
  );
  for (let i = 0; i < 50; i += 1) {
    const stats = await drain.runOnce();
    if (stats.claimed === 0 && stats.dead === 0) break;
  }
}, 60_000);

afterAll(async () => {
  await ctx.close();
});

describe('OutboxRelay (F2-11)', () => {
  it('delivers pending events across tenants exactly once and records delivery state', async () => {
    const idA = await seedEvent(orgA);
    const idB = await seedEvent(orgB);
    const { published, publisher } = recordingPublisher();
    const relay = new OutboxRelay(ctx.relay, publisher, { workerId: 'w-test-1', batchSize: 50 });

    const stats = await relay.runOnce();
    expect(stats.claimed).toBeGreaterThanOrEqual(2);
    expect(stats.dead).toBe(0);

    // Vision cross-tenant sancionada: eventos de AMBOS tenants despachados.
    const mine = published.filter((e) => e.id === idA || e.id === idB);
    expect(mine.map((e) => e.tenantId).sort()).toEqual([orgA, orgB].sort());
    expect(mine.every((e) => e.attempt === 1)).toBe(true);

    for (const id of [idA, idB]) {
      const row = await eventRow(id);
      expect(row.status).toBe('delivered');
      expect(row.delivered_at).not.toBeNull();
      expect(row.last_error).toBeNull();
      expect(row.locked_by).toBeNull();
    }

    // Un segundo ciclo no re-entrega nada de lo ya entregado.
    const before = published.length;
    await relay.runOnce();
    expect(published.filter((e) => e.id === idA || e.id === idB)).toHaveLength(mine.length);
    expect(published.length).toBeGreaterThanOrEqual(before); // otros tests pueden sembrar
  });

  it('CA Gate: two concurrent relays never double-deliver (SKIP LOCKED)', async () => {
    const ids = await Promise.all(Array.from({ length: 30 }, () => seedEvent(orgA)));
    const seen = new Map<string, number>();
    const slowPublisher: OutboxPublisher = {
      async publish(event) {
        seen.set(event.id, (seen.get(event.id) ?? 0) + 1);
        await new Promise((r) => setTimeout(r, 3));
      },
    };
    const r1 = new OutboxRelay(ctx.relay, slowPublisher, { workerId: 'w1', batchSize: 5 });
    const r2 = new OutboxRelay(ctx.relay, slowPublisher, { workerId: 'w2', batchSize: 5 });

    // Ciclos intercalados de ambos workers hasta drenar TODOS los sembrados.
    for (let round = 0; round < 50 && ids.some((id) => !seen.has(id)); round += 1) {
      await Promise.all([r1.runOnce(), r2.runOnce()]);
    }

    for (const id of ids) {
      expect(seen.get(id), `evento ${id} entregado != 1 vez`).toBe(1);
      expect((await eventRow(id)).status).toBe('delivered');
    }
  });

  it('failure -> exponential backoff with jitter, then success on retry', async () => {
    const id = await seedEvent(orgA);
    let calls = 0;
    const flaky: OutboxPublisher = {
      async publish(event) {
        if (event.id === id && calls++ === 0) throw new Error('downstream unavailable');
      },
    };
    const relay = new OutboxRelay(ctx.relay, flaky, {
      batchSize: 50,
      baseBackoffMs: 60_000, // grande para poder distinguir lease (30s) de backoff
      jitterRatio: 0.2,
    });

    await relay.runOnce();
    const failed = await eventRow(id);
    expect(failed.status).toBe('pending');
    expect(failed.attempts).toBe(1);
    expect(failed.last_error).toMatch(/downstream unavailable/);
    // backoff attempt=1: 60s +/-20% jitter
    const ms = Number(failed.future_ms);
    expect(ms).toBeGreaterThan(60_000 * 0.75);
    expect(ms).toBeLessThan(60_000 * 1.25);

    // Aun no elegible; un ciclo no lo toca.
    const stats = await relay.runOnce();
    expect((await eventRow(id)).attempts).toBe(1);
    expect(stats.dead).toBe(0);

    // Expira el backoff -> se reintenta y entrega.
    await ctx.admin.query(`UPDATE outbox_events SET next_attempt_at = now() WHERE id = $1`, [id]);
    await relay.runOnce();
    const done = await eventRow(id);
    expect(done.status).toBe('delivered');
    expect(done.attempts).toBe(2);
  });

  it('poison payload (invalid envelope) goes dead WITHOUT calling the publisher', async () => {
    const res = await ctx.admin.query<{ id: string }>(
      `INSERT INTO outbox_events (tenant_id, topic, payload)
       VALUES ($1, 'test.poison', '{"not":"an envelope"}') RETURNING id::text AS id`,
      [orgA]
    );
    const id = res.rows[0]!.id;
    const { published, publisher } = recordingPublisher();
    const relay = new OutboxRelay(ctx.relay, publisher, { batchSize: 50 });

    const stats = await relay.runOnce();
    expect(stats.dead).toBeGreaterThanOrEqual(1);
    expect(published.some((e) => e.id === id)).toBe(false);
    const row = await eventRow(id);
    expect(row.status).toBe('dead');
    expect(row.last_error).toMatch(/poison/);
  });

  it('exhausted attempts -> dead with the last error preserved', async () => {
    const id = await seedEvent(orgB);
    const alwaysFail: OutboxPublisher = {
      async publish(event) {
        if (event.id === id) throw new Error('permanent failure');
        // otros eventos sembrados por tests anteriores se entregan
      },
    };
    const relay = new OutboxRelay(ctx.relay, alwaysFail, { batchSize: 50, maxAttempts: 2 });

    await relay.runOnce(); // intento 1 falla
    await ctx.admin.query(`UPDATE outbox_events SET next_attempt_at = now() WHERE id = $1`, [id]);
    await relay.runOnce(); // intento 2 falla => dead
    const row = await eventRow(id);
    expect(row.status).toBe('dead');
    expect(row.attempts).toBe(2);
    expect(row.last_error).toMatch(/permanent failure/);
  });

  it('a leased (in-flight) event is not claimable; an expired lease is re-claimed', async () => {
    const id = await seedEvent(orgA);
    // Simula claim de un worker que murio: lease vigente.
    await ctx.admin.query(
      `UPDATE outbox_events
       SET attempts = 1, locked_by = 'w-crashed', next_attempt_at = now() + interval '25 seconds'
       WHERE id = $1`,
      [id]
    );
    const { published, publisher } = recordingPublisher();
    const relay = new OutboxRelay(ctx.relay, publisher, { batchSize: 50 });

    await relay.runOnce();
    expect(published.some((e) => e.id === id)).toBe(false); // lease vigente => intocable

    await ctx.admin.query(`UPDATE outbox_events SET next_attempt_at = now() WHERE id = $1`, [id]);
    await relay.runOnce();
    const row = await eventRow(id);
    expect(row.status).toBe('delivered');
    expect(row.attempts).toBe(2); // el re-claim incremento
    expect(published.find((e) => e.id === id)?.attempt).toBe(2);
  });

  it('zombie sweep: pending with exhausted attempts and expired lease goes dead', async () => {
    const id = await seedEvent(orgB);
    await ctx.admin.query(
      `UPDATE outbox_events SET attempts = 8, next_attempt_at = now() WHERE id = $1`,
      [id]
    );
    const { published, publisher } = recordingPublisher();
    const relay = new OutboxRelay(ctx.relay, publisher, { batchSize: 50, maxAttempts: 8 });
    const stats = await relay.runOnce();
    expect(stats.dead).toBeGreaterThanOrEqual(1);
    expect(published.some((e) => e.id === id)).toBe(false);
    const row = await eventRow(id);
    expect(row.status).toBe('dead');
    expect(row.last_error).toMatch(/exhausted/);
  });

  it('computeBackoffMs doubles per attempt and caps at maxBackoffMs', () => {
    const opts = { baseBackoffMs: 1000, maxBackoffMs: 10_000 };
    expect(computeBackoffMs(opts, 1)).toBe(1000);
    expect(computeBackoffMs(opts, 2)).toBe(2000);
    expect(computeBackoffMs(opts, 3)).toBe(4000);
    expect(computeBackoffMs(opts, 5)).toBe(10_000); // cap
    expect(computeBackoffMs(opts, 50)).toBe(10_000); // sin overflow util
  });
});

describe('replay auditado de eventos dead (V4 §20)', () => {
  it('replays ONLY dead events, resets delivery state and leaves a platform audit trail', async () => {
    const deadId = await seedEvent(orgA);
    const deliveredId = await seedEvent(orgA);
    await ctx.admin.query(
      `UPDATE outbox_events SET status='dead', attempts=8, last_error='x' WHERE id=$1`,
      [deadId]
    );
    await ctx.admin.query(
      `UPDATE outbox_events SET status='delivered', delivered_at=now() WHERE id=$1`,
      [deliveredId]
    );

    const requestId = `replay-${randomUUID()}`;
    const operatorId = randomUUID(); // audit_events.actor_id es UUID
    const replayed = await replayDeadOutboxEvents(ctx.admin, {
      eventIds: [deadId, deliveredId],
      reason: 'incident 42: downstream restored, requeueing dead events',
      actorId: operatorId,
      requestId,
    });
    expect(replayed).toEqual([deadId]); // delivered NO se resucita

    const row = await eventRow(deadId);
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(0);
    expect(row.last_error).toBeNull();

    const audit = await ctx.admin.query<{ reason: string; after_summary: unknown }>(
      `SELECT reason, after_summary FROM audit_events
       WHERE action = 'platform.operation' AND resource_type = 'outbox_event'
         AND request_id = $1`,
      [requestId]
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0]!.reason).toMatch(/incident 42/);
    const summary = audit.rows[0]!.after_summary as { replayed_ids: string[]; requested: number };
    expect(summary.requested).toBe(2);
    expect(summary.replayed_ids).toEqual([deadId]);
  });

  it('refuses to replay without an explicit reason', async () => {
    await expect(
      replayDeadOutboxEvents(ctx.admin, { eventIds: ['1'], reason: '  ' })
    ).rejects.toThrow(PlatformReasonRequiredError);
  });
});

describe('privilegios del rol relay (AUD-P1-007, ADR-0011)', () => {
  it('relay cannot INSERT, DELETE, or rewrite payload/topic/tenant_id', async () => {
    const id = await seedEvent(orgA);
    await expect(
      ctx.relay.query(
        `INSERT INTO outbox_events (tenant_id, topic, payload) VALUES ($1,'x','{}')`,
        [orgA]
      )
    ).rejects.toThrow(/permission denied/i);
    await expect(ctx.relay.query(`DELETE FROM outbox_events WHERE id = $1`, [id])).rejects.toThrow(
      /permission denied/i
    );
    await expect(
      ctx.relay.query(`UPDATE outbox_events SET payload = '{}' WHERE id = $1`, [id])
    ).rejects.toThrow(/permission denied/i);
    await expect(
      ctx.relay.query(`UPDATE outbox_events SET topic = 'evil' WHERE id = $1`, [id])
    ).rejects.toThrow(/permission denied/i);
  });

  it('relay sees outbox_events cross-tenant but NOTHING else', async () => {
    const visible = await ctx.relay.query<{ n: number }>(
      `SELECT count(DISTINCT tenant_id)::int AS n FROM outbox_events WHERE tenant_id IN ($1, $2)`,
      [orgA, orgB]
    );
    expect(visible.rows[0]!.n).toBe(2);

    for (const table of ['ledger_entries', 'api_keys', 'users', 'sessions', 'merchants']) {
      await expect(ctx.relay.query(`SELECT 1 FROM ${table} LIMIT 1`)).rejects.toThrow(
        /permission denied/i
      );
    }
  });
});
