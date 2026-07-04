import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createTestContext, type TestContext } from '@fluvia/db/testing';
import { PlatformReasonRequiredError } from '@fluvia/audit';
import {
  InboxIngestService,
  InboxProcessor,
  InvalidWebhookSignatureError,
  PayloadTooLargeError,
  replayDeadProviderEvents,
  signWebhookPayload,
  type ParsedProviderEvent,
} from '../src/index.js';

let ctx: TestContext;
let ingest: InboxIngestService;

const SECRET = 'whsec_inbox_test_secret';

/** Schema minimo del "proveedor" de prueba. */
const TestEventSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    amount: z.number().int().optional(),
    card_token: z.string().optional(),
  })
  .strict();

function freshProvider(): string {
  return `prov-${randomUUID().slice(0, 8)}`;
}

function makeBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ id: `pe-${randomUUID()}`, type: 'payment.captured', ...overrides });
}

async function ingestOk(provider: string, body: string, eventId?: string) {
  const ts = Date.now();
  return ingest.ingest({
    provider,
    providerEventId: eventId ?? (JSON.parse(body) as { id: string }).id,
    eventType: 'payment.captured',
    rawBody: body,
    headers: { 'content-type': 'application/json', 'x-evil-header': 'drop-me' },
    signature: { secret: SECRET, timestampMs: ts, signature: signWebhookPayload(SECRET, ts, body) },
  });
}

async function eventRow(id: string) {
  const res = await ctx.admin.query<{
    status: string;
    result: string | null;
    attempts: number;
    last_error: string | null;
    headers: Record<string, string>;
    signature_verified: boolean;
    processed_at: Date | null;
  }>(
    `SELECT status, result, attempts, last_error, headers, signature_verified, processed_at
     FROM provider_events WHERE id = $1`,
    [id]
  );
  return res.rows[0]!;
}

beforeAll(async () => {
  ctx = await createTestContext();
  ingest = new InboxIngestService(ctx.app);
}, 30_000);

afterAll(async () => {
  await ctx.close();
});

describe('ingesta durable (CA: duplicados -> 1 procesamiento)', () => {
  it('persists a signed event with allowlisted headers only, readable by NO api role', async () => {
    const provider = freshProvider();
    const body = makeBody();
    const res = await ingestOk(provider, body);
    expect(res.duplicate).toBe(false);
    expect(res.id).toBeTruthy();

    const row = await eventRow(res.id!);
    expect(row.status).toBe('pending');
    expect(row.signature_verified).toBe(true);
    expect(row.headers).toEqual({ 'content-type': 'application/json' }); // x-evil-header fuera

    // El CONTENIDO del buzon no es legible ni actualizable por el rol de la
    // API (solo las columnas del arbitro de dedup + id, exigidas por
    // ON CONFLICT/RETURNING).
    await expect(ctx.app.query('SELECT raw_body FROM provider_events LIMIT 1')).rejects.toThrow(
      /permission denied/i
    );
    await expect(ctx.app.query('SELECT * FROM provider_events LIMIT 1')).rejects.toThrow(
      /permission denied/i
    );
    await expect(
      ctx.app.query(`UPDATE provider_events SET status = 'processed' WHERE id = $1`, [res.id])
    ).rejects.toThrow(/permission denied/i);
  });

  it('the same (provider, provider_event_id) delivered N times concurrently persists EXACTLY once', async () => {
    const provider = freshProvider();
    const body = makeBody();
    const eventId = (JSON.parse(body) as { id: string }).id;

    const results = await Promise.all(
      Array.from({ length: 6 }, () => ingestOk(provider, body, eventId))
    );
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(results.filter((r) => r.duplicate)).toHaveLength(5);

    const count = await ctx.admin.query(
      `SELECT count(*)::int AS n FROM provider_events WHERE provider = $1 AND provider_event_id = $2`,
      [provider, eventId]
    );
    expect(count.rows[0]!.n).toBe(1);
  });

  it('the same provider_event_id from DIFFERENT providers is not a duplicate', async () => {
    const eventId = `pe-${randomUUID()}`;
    const body = makeBody();
    const a = await ingestOk(freshProvider(), body, eventId);
    const b = await ingestOk(freshProvider(), body, eventId);
    expect(a.duplicate).toBe(false);
    expect(b.duplicate).toBe(false);
  });

  it('an invalid signature persists NOTHING; an oversized body is rejected', async () => {
    const provider = freshProvider();
    const body = makeBody();
    const ts = Date.now();
    await expect(
      ingest.ingest({
        provider,
        providerEventId: 'pe-bad-sig',
        rawBody: body,
        signature: { secret: SECRET, timestampMs: ts, signature: 'deadbeef' },
      })
    ).rejects.toThrow(InvalidWebhookSignatureError);
    const count = await ctx.admin.query(
      `SELECT count(*)::int AS n FROM provider_events WHERE provider = $1`,
      [provider]
    );
    expect(count.rows[0]!.n).toBe(0);

    const small = new InboxIngestService(ctx.app, { maxBodyBytes: 16 });
    await expect(
      small.ingest({
        provider,
        providerEventId: 'pe-too-big',
        rawBody: body,
        signature: {
          secret: SECRET,
          timestampMs: ts,
          signature: signWebhookPayload(SECRET, ts, body),
        },
      })
    ).rejects.toThrow(PayloadTooLargeError);
  });
});

describe('procesador asincrono (claim-lease, DLQ, fuera de orden)', () => {
  function makeProcessor(
    handler: (
      e: ParsedProviderEvent
    ) => Promise<{ outcome: 'applied' | 'ignored_out_of_order' | 'ignored'; detail?: string }>,
    provider: string,
    opts: ConstructorParameters<typeof InboxProcessor>[1] = {}
  ) {
    const processor = new InboxProcessor(ctx.inbox, { batchSize: 50, ...opts });
    processor.register(provider, { schema: TestEventSchema, handler });
    return processor;
  }

  it('applies a valid event: processed + result + processed_at', async () => {
    const provider = freshProvider();
    const res = await ingestOk(provider, makeBody({ amount: 5000 }));
    const seen: ParsedProviderEvent[] = [];
    const processor = makeProcessor(async (e) => {
      seen.push(e);
      return { outcome: 'applied', detail: 'intent transitioned' };
    }, provider);

    const stats = await processor.runOnce();
    expect(stats.processed).toBeGreaterThanOrEqual(1);
    const mine = seen.find((e) => e.id === res.id);
    expect(mine).toBeTruthy();
    expect((mine!.payload as { amount: number }).amount).toBe(5000);

    const row = await eventRow(res.id!);
    expect(row.status).toBe('processed');
    expect(row.result).toBe('applied: intent transitioned');
    expect(row.processed_at).not.toBeNull();
  });

  it('CA: an out-of-order event is recorded as ignored_out_of_order, not retried', async () => {
    const provider = freshProvider();
    const res = await ingestOk(provider, makeBody());
    const processor = makeProcessor(
      async () => ({ outcome: 'ignored_out_of_order', detail: 'intent already succeeded' }),
      provider
    );
    await processor.runOnce();
    const row = await eventRow(res.id!);
    expect(row.status).toBe('ignored');
    expect(row.result).toBe('ignored_out_of_order: intent already succeeded');

    // Terminal: otro ciclo no lo vuelve a tocar.
    const stats = await processor.runOnce();
    expect((await eventRow(res.id!)).attempts).toBe(1);
    expect(stats.claimed).toBe(0);
  });

  it('schema-invalid payload goes dead + REDACTED copy in the DLQ', async () => {
    const provider = freshProvider();
    // valido para ingesta (firma ok) pero fuera del schema del provider,
    // con un campo sensible que DEBE quedar redactado en la DLQ.
    const body = JSON.stringify({
      id: `pe-${randomUUID()}`,
      type: 'payment.captured',
      card_token: 'tok_super_secret',
      unexpected_field: true,
    });
    const res = await ingestOk(provider, body);
    let handlerCalls = 0;
    const processor = makeProcessor(async () => {
      handlerCalls += 1;
      return { outcome: 'applied' };
    }, provider);

    const stats = await processor.runOnce();
    expect(stats.dead).toBeGreaterThanOrEqual(1);
    expect(handlerCalls).toBe(0); // veneno jamas llega al handler

    const row = await eventRow(res.id!);
    expect(row.status).toBe('dead');
    expect(row.last_error).toMatch(/poison: schema validation failed/);

    const dlq = await ctx.admin.query<{
      payload: { payload: Record<string, unknown> };
      validation_error: string;
    }>(`SELECT payload, validation_error FROM raw_provider_payloads_dlq WHERE provider = $1`, [
      provider,
    ]);
    expect(dlq.rowCount).toBe(1);
    expect(dlq.rows[0]!.validation_error).toMatch(/unexpected_field|unrecognized/i);
    // Redaccion: la clave sensible no viaja en claro a la DLQ.
    expect(dlq.rows[0]!.payload.payload['card_token']).toBe('[REDACTED]');
  });

  it('invalid JSON goes dead + DLQ with truncated raw', async () => {
    const provider = freshProvider();
    const body = '{"broken json';
    const ts = Date.now();
    await ingest.ingest({
      provider,
      providerEventId: `pe-${randomUUID()}`,
      rawBody: body,
      signature: {
        secret: SECRET,
        timestampMs: ts,
        signature: signWebhookPayload(SECRET, ts, body),
      },
    });
    const processor = makeProcessor(async () => ({ outcome: 'applied' }), provider);
    await processor.runOnce();
    const dlq = await ctx.admin.query(
      `SELECT 1 FROM raw_provider_payloads_dlq WHERE provider = $1 AND validation_error LIKE 'invalid JSON%'`,
      [provider]
    );
    expect(dlq.rowCount).toBe(1);
  });

  it('an unknown provider goes dead (config gap) and is recoverable via audited replay', async () => {
    const provider = freshProvider();
    const res = await ingestOk(provider, makeBody());
    const processor = new InboxProcessor(ctx.inbox, { batchSize: 50 }); // sin registro
    await processor.runOnce();
    expect((await eventRow(res.id!)).status).toBe('dead');
    expect((await eventRow(res.id!)).last_error).toMatch(/no handler registered/);

    // Se despliega el handler y se resucita con razon auditada.
    const requestId = `replay-${randomUUID()}`;
    const replayed = await replayDeadProviderEvents(ctx.admin, {
      eventIds: [res.id!],
      reason: 'handler deployed for provider, reprocessing dead events',
      actorId: randomUUID(),
      requestId,
    });
    expect(replayed).toEqual([res.id]);
    expect((await eventRow(res.id!)).status).toBe('pending');
    expect((await eventRow(res.id!)).attempts).toBe(0);

    const audit = await ctx.admin.query(
      `SELECT 1 FROM audit_events
       WHERE action = 'platform.operation' AND resource_type = 'provider_event' AND request_id = $1`,
      [requestId]
    );
    expect(audit.rowCount).toBe(1);

    const fixed = makeProcessor(async () => ({ outcome: 'applied' }), provider);
    await fixed.runOnce();
    expect((await eventRow(res.id!)).status).toBe('processed');
  });

  it('replay without a reason is refused', async () => {
    await expect(
      replayDeadProviderEvents(ctx.admin, { eventIds: ['1'], reason: '' })
    ).rejects.toThrow(PlatformReasonRequiredError);
  });

  it('handler failure -> backoff retry; exhausted attempts -> dead', async () => {
    const provider = freshProvider();
    const res = await ingestOk(provider, makeBody());
    let calls = 0;
    const processor = makeProcessor(
      async () => {
        calls += 1;
        throw new Error('downstream FSM unavailable');
      },
      provider,
      { maxAttempts: 2, baseBackoffMs: 60_000 }
    );

    await processor.runOnce(); // intento 1
    let row = await eventRow(res.id!);
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(1);
    expect(row.last_error).toMatch(/downstream FSM unavailable/);

    await ctx.admin.query(`UPDATE provider_events SET next_attempt_at = now() WHERE id = $1`, [
      res.id,
    ]);
    await processor.runOnce(); // intento 2 == max -> dead
    row = await eventRow(res.id!);
    expect(row.status).toBe('dead');
    expect(row.attempts).toBe(2);
    expect(calls).toBe(2);
  });

  it('CA: two concurrent processors never double-process (SKIP LOCKED)', async () => {
    const provider = freshProvider();
    const ids = [];
    for (let i = 0; i < 20; i += 1) {
      const r = await ingestOk(provider, makeBody());
      ids.push(r.id!);
    }
    const seen = new Map<string, number>();
    const handler = async (e: ParsedProviderEvent) => {
      seen.set(e.id, (seen.get(e.id) ?? 0) + 1);
      await new Promise((r) => setTimeout(r, 3));
      return { outcome: 'applied' as const };
    };
    const p1 = makeProcessor(handler, provider, { batchSize: 4, workerId: 'i1' });
    const p2 = makeProcessor(handler, provider, { batchSize: 4, workerId: 'i2' });
    for (let round = 0; round < 50 && ids.some((id) => !seen.has(id)); round += 1) {
      await Promise.all([p1.runOnce(), p2.runOnce()]);
    }
    for (const id of ids) {
      expect(seen.get(id), `evento ${id} procesado != 1 vez`).toBe(1);
      expect((await eventRow(id)).status).toBe('processed');
    }
  });
});

describe('limites de privilegio del rol inbox', () => {
  it('inbox role cannot INSERT/DELETE provider_events nor rewrite raw_body/provider', async () => {
    const provider = freshProvider();
    const res = await ingestOk(provider, makeBody());
    await expect(
      ctx.inbox.query(
        `INSERT INTO provider_events (provider, provider_event_id, raw_body) VALUES ('x','y','{}')`
      )
    ).rejects.toThrow(/permission denied/i);
    await expect(
      ctx.inbox.query(`DELETE FROM provider_events WHERE id = $1`, [res.id])
    ).rejects.toThrow(/permission denied/i);
    await expect(
      ctx.inbox.query(`UPDATE provider_events SET raw_body = '{}' WHERE id = $1`, [res.id])
    ).rejects.toThrow(/permission denied/i);
    await expect(
      ctx.inbox.query(`UPDATE provider_events SET provider = 'evil' WHERE id = $1`, [res.id])
    ).rejects.toThrow(/permission denied/i);
  });

  it('inbox role sees NOTHING outside its plane (ledger, outbox, credentials)', async () => {
    for (const table of ['ledger_entries', 'outbox_events', 'api_keys', 'users', 'sessions']) {
      await expect(ctx.inbox.query(`SELECT 1 FROM ${table} LIMIT 1`)).rejects.toThrow(
        /permission denied/i
      );
    }
  });
});
