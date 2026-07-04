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
