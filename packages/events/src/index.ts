import { randomUUID } from 'node:crypto';
import { z } from 'zod';

/**
 * Envelope comun de eventos de dominio (AUD-P2-005, ADR-0007).
 *
 * TODO evento que entra al outbox lo hace con este sobre; el relay lo valida
 * antes de despachar y trata cualquier payload no conforme como veneno (dead).
 * El contrato es el mismo que veran los webhooks salientes (F3-07): definirlo
 * antes del primer consumidor evita una migracion de esquema de eventos.
 */

export interface EventResource {
  /** Tipo del objeto de dominio principal del evento (p.ej. 'ledger_transaction'). */
  type: string;
  /** Identificador del objeto dentro de su tipo. */
  id: string;
}

export interface EventEnvelope<TData = Record<string, unknown>> {
  /** Id publico, unico y estable del evento: `evt_<uuid>`. */
  event_id: string;
  /** Version del esquema del payload de ESTE topic (no del envelope). */
  schema_version: number;
  /** Momento del hecho de dominio (ISO-8601), no del despacho. */
  occurred_at: string;
  /** Modulo productor, p.ej. 'fluvia.ledger'. */
  producer: string;
  resource: EventResource;
  data: TData;
}

export const EVENT_ID_RE = /^evt_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const EventEnvelopeSchema = z
  .object({
    event_id: z.string().regex(EVENT_ID_RE, 'event_id must be evt_<uuid>'),
    schema_version: z.number().int().positive(),
    occurred_at: z.string().datetime({ offset: true }),
    producer: z.string().min(1),
    resource: z.object({ type: z.string().min(1), id: z.string().min(1) }).strict(),
    data: z.record(z.unknown()),
  })
  .strict();

export interface BuildEnvelopeInput<TData> {
  producer: string;
  resource: EventResource;
  data: TData;
  /** Momento del hecho; default: ahora. Acepta Date o ISO string. */
  occurredAt?: Date | string;
  schemaVersion?: number;
  /** Solo para replays deterministas/tests; en produccion se genera. */
  eventId?: string;
}

export function newEventId(): string {
  return `evt_${randomUUID()}`;
}

export function buildEnvelope<TData extends Record<string, unknown>>(
  input: BuildEnvelopeInput<TData>
): EventEnvelope<TData> {
  const occurred =
    input.occurredAt instanceof Date
      ? input.occurredAt.toISOString()
      : (input.occurredAt ?? new Date().toISOString());
  const envelope: EventEnvelope<TData> = {
    event_id: input.eventId ?? newEventId(),
    schema_version: input.schemaVersion ?? 1,
    occurred_at: occurred,
    producer: input.producer,
    resource: input.resource,
    data: input.data,
  };
  // El productor valida su propio sobre: un evento malformado debe reventar
  // AL EMITIR (misma transaccion que el hecho), no al despacharse horas despues.
  EventEnvelopeSchema.parse(envelope);
  return envelope;
}

export class InvalidEventEnvelopeError extends Error {
  constructor(readonly detail: string) {
    super(`Invalid event envelope: ${detail}`);
    this.name = 'InvalidEventEnvelopeError';
  }
}

/** Valida un payload arbitrario (p.ej. leido del outbox) como envelope. */
export function parseEnvelope(payload: unknown): EventEnvelope {
  const parsed = EventEnvelopeSchema.safeParse(payload);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new InvalidEventEnvelopeError(detail);
  }
  return parsed.data as EventEnvelope;
}

/** Catalogo de topics emitidos hoy (se amplia con cada productor nuevo). */
export const EVENT_TOPICS = {
  ledgerTransactionPosted: 'ledger.transaction.posted',
} as const;
export type EventTopic = (typeof EVENT_TOPICS)[keyof typeof EVENT_TOPICS];
