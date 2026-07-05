import type { Pool } from '@fluvia/db';
import type { ClaimedOutboxEvent, OutboxPublisher, RelayLogger } from '@fluvia/outbox';
import { isWebhookTopic } from './events.js';

/**
 * Fan-out del outbox hacia la cola de webhooks (F3-07).
 *
 * El ORIGEN de todo webhook es exclusivamente el outbox (webhook-delivery.md
 * §1): este publisher corre dentro del relay (rol fluvia_relay, ventanas
 * explicitas de 0019) y materializa UNA fila de webhook_events por endpoint
 * activo del tenant suscrito al topic. Topics fuera del catalogo publico
 * (p.ej. eventos internos del ledger) no generan webhooks.
 *
 * Reintento del relay tras un crash post-publish => posibles filas duplicadas
 * de webhook_events (at-least-once heredado); el comercio deduplica por
 * event_id (whe_) como dicta el contrato.
 */
export function createWebhookFanoutPublisher(
  relayPool: Pool,
  logger?: RelayLogger
): OutboxPublisher {
  return {
    async publish(event: ClaimedOutboxEvent): Promise<void> {
      if (!isWebhookTopic(event.topic)) {
        // Evento interno: entregado sin fan-out (el log queda para trazas).
        logger?.info(
          { outboxId: event.id, topic: event.topic },
          'outbox event without public webhook topic (no fan-out)'
        );
        return;
      }
      const res = await relayPool.query(
        `INSERT INTO webhook_events (tenant_id, endpoint_id, topic, payload)
         SELECT e.tenant_id, e.id, $2, $3::jsonb
         FROM webhook_endpoints e
         WHERE e.tenant_id = $1
           AND e.status = 'active'
           AND (e.events = '{}' OR $2 = ANY(e.events))`,
        [event.tenantId, event.topic, JSON.stringify(event.envelope)]
      );
      logger?.info(
        { outboxId: event.id, topic: event.topic, endpoints: res.rowCount ?? 0 },
        'outbox event fanned out to webhook queue'
      );
    },
  };
}
