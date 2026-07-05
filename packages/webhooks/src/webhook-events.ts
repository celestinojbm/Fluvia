import { insertAuditEvent, type AuditContext } from '@fluvia/audit';
import { withTenantTransaction, type Pool } from '@fluvia/db';

/**
 * Lectura de la cola de webhooks salientes (F3-09a) + reenvío manual auditado
 * de eventos `dead`. Todo bajo el rol `fluvia_app` (RLS por tenant): un comercio
 * solo ve y reenvía sus propios eventos.
 *
 * `fluvia_app` tiene SELECT sobre webhook_events/webhook_attempts pero NO
 * INSERT/UPDATE (revocados en 0019). El reenvío entra por la función SECURITY
 * DEFINER acotada `webhook_event_resend` (0026), que clona un evento `dead` como
 * uno `pending` fresco (no resucita el muerto — estado terminal inmutable).
 */

export class WebhookEventNotFoundError extends Error {
  constructor() {
    super('Webhook event not found');
    this.name = 'WebhookEventNotFoundError';
  }
}

/** El reenvío solo aplica a eventos en estado `dead`. */
export class WebhookEventNotDeadError extends Error {
  constructor() {
    super('Only dead webhook events can be resent');
    this.name = 'WebhookEventNotDeadError';
  }
}

export const WEBHOOK_EVENT_STATUSES = ['pending', 'delivered', 'dead'] as const;
export type WebhookEventStatus = (typeof WEBHOOK_EVENT_STATUSES)[number];

export interface WebhookEventDto {
  id: string;
  endpointId: string;
  topic: string;
  status: string;
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  deliveredAt: string | null;
  resentFromEventId: string | null;
  createdAt: string;
}

export interface WebhookAttemptDto {
  attemptNumber: number;
  statusCode: number | null;
  error: string | null;
  latencyMs: number | null;
  resolvedIp: string | null;
  createdAt: string;
}

export interface WebhookEventDetail extends WebhookEventDto {
  payload: unknown;
  attemptsHistory: WebhookAttemptDto[];
}

export interface ListWebhookEventsOptions {
  endpointId?: string;
  status?: WebhookEventStatus;
  limit?: number;
}

interface EventRow {
  id: string;
  endpoint_id: string;
  topic: string;
  status: string;
  attempts: number;
  next_attempt_at: Date | null;
  last_error: string | null;
  delivered_at: Date | null;
  resent_from_event_id: string | null;
  created_at: Date;
}

interface AttemptRow {
  attempt_number: number;
  status_code: number | null;
  error: string | null;
  latency_ms: number | null;
  resolved_ip: string | null;
  created_at: Date;
}

const EVENT_COLUMNS = `id, endpoint_id, topic, status, attempts, next_attempt_at, last_error,
  delivered_at, resent_from_event_id, created_at`;

function toDto(r: EventRow): WebhookEventDto {
  return {
    id: r.id,
    endpointId: r.endpoint_id,
    topic: r.topic,
    status: r.status,
    attempts: r.attempts,
    nextAttemptAt: r.next_attempt_at?.toISOString() ?? null,
    lastError: r.last_error,
    deliveredAt: r.delivered_at?.toISOString() ?? null,
    resentFromEventId: r.resent_from_event_id,
    createdAt: r.created_at.toISOString(),
  };
}

export class WebhookEventService {
  constructor(
    /** Pool con rol fluvia_app (RLS forzado). */
    private readonly appPool: Pool
  ) {}

  async list(tenantId: string, options: ListWebhookEventsOptions = {}): Promise<WebhookEventDto[]> {
    const limit = Math.min(Math.max(Math.floor(options.limit ?? 25), 1), 100);
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const res = await c.query<EventRow>(
        `SELECT ${EVENT_COLUMNS}
         FROM webhook_events
         WHERE ($1::uuid IS NULL OR endpoint_id = $1)
           AND ($2::text IS NULL OR status = $2)
         ORDER BY created_at DESC, id DESC
         LIMIT $3`,
        [options.endpointId ?? null, options.status ?? null, limit]
      );
      return res.rows.map(toDto);
    });
  }

  async get(tenantId: string, eventId: string): Promise<WebhookEventDetail> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const ev = await c.query<EventRow & { payload: unknown }>(
        `SELECT ${EVENT_COLUMNS}, payload FROM webhook_events WHERE id = $1`,
        [eventId]
      );
      const row = ev.rows[0];
      if (!row) throw new WebhookEventNotFoundError();
      const attempts = await c.query<AttemptRow>(
        `SELECT attempt_number, status_code, error, latency_ms, resolved_ip, created_at
         FROM webhook_attempts
         WHERE webhook_event_id = $1
         ORDER BY attempt_number`,
        [eventId]
      );
      return {
        ...toDto(row),
        payload: row.payload,
        attemptsHistory: attempts.rows.map((a) => ({
          attemptNumber: a.attempt_number,
          statusCode: a.status_code,
          error: a.error,
          latencyMs: a.latency_ms,
          resolvedIp: a.resolved_ip,
          createdAt: a.created_at.toISOString(),
        })),
      };
    });
  }

  /**
   * Reenvía un evento `dead`: la función definer clona (tenant, endpoint, topic,
   * payload) como un evento `pending` fresco enlazado al muerto; el audit event
   * `webhook_event.resent` se escribe en la MISMA transacción (rastro atómico).
   * Devuelve el evento nuevo. Idempotencia: cada reenvío encola una entrega
   * distinta (acción manual del operador), no se deduplica.
   */
  async resend(tenantId: string, eventId: string, context: AuditContext): Promise<WebhookEventDto> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      // Distingue not-found de not-dead para un error preciso (ambos bajo RLS).
      const existing = await c.query<{ status: string }>(
        `SELECT status FROM webhook_events WHERE id = $1`,
        [eventId]
      );
      if (!existing.rows[0]) throw new WebhookEventNotFoundError();
      if (existing.rows[0].status !== 'dead') throw new WebhookEventNotDeadError();

      const resent = await c.query<{ webhook_event_resend: string | null }>(
        `SELECT webhook_event_resend($1, $2)`,
        [eventId, tenantId]
      );
      const newId = resent.rows[0]?.webhook_event_resend ?? null;
      // Carrera: el estado cambió entre el SELECT y el definer (p.ej. otro
      // reenvío ya lo tomó) — sin fila `dead`, tratamos como not-dead.
      if (!newId) throw new WebhookEventNotDeadError();

      await insertAuditEvent(c, {
        action: 'webhook_event.resent',
        tenantId,
        context,
        resourceType: 'webhook_event',
        resourceId: newId,
        riskLevel: 'medium',
        reason: `manual resend of dead webhook event ${eventId}`,
        before: { deadEventId: eventId },
        after: { newEventId: newId },
      });

      const fresh = await c.query<EventRow>(
        `SELECT ${EVENT_COLUMNS} FROM webhook_events WHERE id = $1`,
        [newId]
      );
      return toDto(fresh.rows[0]!);
    });
  }
}
