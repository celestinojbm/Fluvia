import { describe, expect, it } from 'vitest';
import {
  EVENT_ID_RE,
  EventEnvelopeSchema,
  InvalidEventEnvelopeError,
  buildEnvelope,
  newEventId,
  parseEnvelope,
} from '../src/index.js';

describe('event envelope (AUD-P2-005)', () => {
  const base = {
    producer: 'fluvia.ledger',
    resource: { type: 'ledger_transaction', id: 'abc-123' },
    data: { transaction_id: 'abc-123', reason: 'payment' },
  };

  it('builds a schema-valid envelope with generated evt_ id and ISO timestamp', () => {
    const env = buildEnvelope(base);
    expect(env.event_id).toMatch(EVENT_ID_RE);
    expect(env.schema_version).toBe(1);
    expect(new Date(env.occurred_at).getTime()).not.toBeNaN();
    expect(EventEnvelopeSchema.safeParse(env).success).toBe(true);
    // ids unicos entre construcciones
    expect(buildEnvelope(base).event_id).not.toBe(env.event_id);
  });

  it('respects explicit occurredAt (Date) and schemaVersion', () => {
    const when = new Date('2026-07-04T12:00:00.000Z');
    const env = buildEnvelope({ ...base, occurredAt: when, schemaVersion: 3 });
    expect(env.occurred_at).toBe('2026-07-04T12:00:00.000Z');
    expect(env.schema_version).toBe(3);
  });

  it('parseEnvelope rejects malformed payloads with a useful detail', () => {
    expect(() => parseEnvelope({ hello: 'world' })).toThrow(InvalidEventEnvelopeError);
    expect(() => parseEnvelope(null)).toThrow(InvalidEventEnvelopeError);
    // sin event_id valido
    expect(() =>
      parseEnvelope({
        ...buildEnvelope(base),
        event_id: 'not-an-event-id',
      })
    ).toThrow(/event_id/);
    // campos extra prohibidos (strict): un envelope adulterado no pasa
    expect(() => parseEnvelope({ ...buildEnvelope(base), extra: true })).toThrow(
      InvalidEventEnvelopeError
    );
  });

  it('builder refuses to emit an invalid envelope (fails at produce-time)', () => {
    expect(() => buildEnvelope({ ...base, producer: '' })).toThrow();
    expect(() => buildEnvelope({ ...base, resource: { type: '', id: 'x' } })).toThrow();
  });

  it('newEventId produces evt_-prefixed uuids', () => {
    expect(newEventId()).toMatch(EVENT_ID_RE);
  });
});

// Migración zod 3 → 4: `z.record(valueSchema)` de un argumento dejó de existir
// (ahora `z.record(keySchema, valueSchema)`). Estos casos fijan que `data`
// sigue siendo un objeto plano de claves string y que `occurred_at` sigue
// exigiendo ISO-8601 con zona.
describe('event envelope — contrato estable tras zod 4', () => {
  const base = {
    producer: 'fluvia.ledger',
    resource: { type: 'ledger_transaction', id: 'abc-123' },
    data: { transaction_id: 'abc-123' },
  };

  it('data accepts any plain object (including empty) and rejects non-objects', () => {
    const env = buildEnvelope(base);
    expect(EventEnvelopeSchema.safeParse({ ...env, data: {} }).success).toBe(true);
    expect(EventEnvelopeSchema.safeParse({ ...env, data: { nested: { a: [1, 2] } } }).success).toBe(
      true
    );
    for (const bad of [null, [], 'x', 42]) {
      expect(EventEnvelopeSchema.safeParse({ ...env, data: bad }).success, String(bad)).toBe(false);
    }
  });

  it('occurred_at requires an ISO-8601 timestamp with Z or numeric offset', () => {
    const env = buildEnvelope(base);
    const ok = ['2026-07-04T12:00:00.000Z', '2026-07-04T12:00:00Z', '2026-07-04T07:00:00-05:00'];
    for (const v of ok) {
      expect(EventEnvelopeSchema.safeParse({ ...env, occurred_at: v }).success, v).toBe(true);
    }
    const bad = ['2026-07-04 12:00:00', '2026-07-04', 'yesterday'];
    for (const v of bad) {
      expect(EventEnvelopeSchema.safeParse({ ...env, occurred_at: v }).success, v).toBe(false);
    }
  });
});
