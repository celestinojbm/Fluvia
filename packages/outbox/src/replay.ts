import { withPlatformOperation } from '@fluvia/audit';
import type { Pool } from '@fluvia/db';

/**
 * Replay auditado de eventos dead (F2-11, V4 §20).
 *
 * dead -> pending SOLO por este camino: operacion de plataforma con razon
 * obligatoria, auditada en la MISMA transaccion (accion platform.operation,
 * riesgo alto, con los ids realmente tocados en el detalle). Corre con el
 * pool administrativo: el rol relay NO puede resucitar eventos por si mismo
 * (sus updates via RLS/grants no incluyen esa transicion legitimamente — y
 * ningun camino de codigo del relay la ejecuta).
 */

export interface ReplayDeadEventsOptions {
  /** ids (BIGINT como string) de outbox_events en estado dead. */
  eventIds: string[];
  /** OBLIGATORIA — quien y por que resucita estos eventos. */
  reason: string;
  /** UUID del operador (audit_events.actor_id es UUID). */
  actorId?: string;
  requestId?: string;
}

/** Devuelve los ids efectivamente re-encolados (subset de eventIds en dead). */
export async function replayDeadOutboxEvents(
  adminPool: Pool,
  options: ReplayDeadEventsOptions
): Promise<string[]> {
  const details: { replayed_ids?: string[]; requested: number } = {
    requested: options.eventIds.length,
  };
  return withPlatformOperation(
    adminPool,
    {
      tenantId: null,
      actorId: options.actorId,
      reason: options.reason,
      requestId: options.requestId,
      resourceType: 'outbox_event',
      details,
    },
    async (client) => {
      const res = await client.query<{ id: string }>(
        `UPDATE outbox_events
         SET status = 'pending', attempts = 0, next_attempt_at = now(),
             last_error = NULL, locked_by = NULL
         WHERE id = ANY($1::bigint[]) AND status = 'dead'
         RETURNING id::text AS id`,
        [options.eventIds]
      );
      const ids = res.rows.map((r) => r.id);
      details.replayed_ids = ids;
      return ids;
    }
  );
}
