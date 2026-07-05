import type { FastifyInstance } from 'fastify';
import { InboxIngestService } from '@fluvia/inbox';
import { MOCK_PROVIDER_NAME } from '@fluvia/payments-core';

/**
 * Ingesta HTTP de webhooks de proveedores (F3-03b, cierra el "endpoint HTTP
 * llega en F3" de F2-12).
 *
 * Autenticacion: NO hay API key — el emisor es el proveedor; la credencial es
 * la firma HMAC (timestamp firmado, tolerancia ±5 min, comparacion en tiempo
 * constante) verificada ANTES de persistir nada. Dedup race-safe por
 * (provider, provider_event_id). La respuesta 200 significa "durable":
 * el procesamiento es asincrono (InboxProcessor en el worker).
 *
 * El body se captura CRUDO (parser scoped a este plugin): la firma cubre los
 * bytes exactos, no una re-serializacion.
 */

export interface ProviderWebhookRoutesOptions {
  ingestService: InboxIngestService;
  mockWebhookSecret: string;
}

export function registerProviderWebhookRoutes(
  app: FastifyInstance,
  { ingestService, mockWebhookSecret }: ProviderWebhookRoutesOptions
): void {
  void app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'string', bodyLimit: 1024 * 1024 },
      (_req, body, done) => {
        done(null, body);
      }
    );

    scope.post('/v1/providers/mock/webhook', async (req, reply) => {
      const rawBody = typeof req.body === 'string' ? req.body : '';
      const timestamp = Number(req.headers['x-fluvia-timestamp']);
      const signature = String(req.headers['x-fluvia-signature'] ?? '');

      // Parseo sin efectos para extraer event_id/type; la firma se verifica
      // sobre los BYTES crudos dentro de ingest() antes de persistir nada.
      let parsed: { event_id?: unknown; type?: unknown };
      try {
        parsed = JSON.parse(rawBody) as { event_id?: unknown; type?: unknown };
      } catch {
        return reply.code(400).send();
      }
      const eventId = typeof parsed.event_id === 'string' ? parsed.event_id : '';
      if (!eventId) return reply.code(400).send();

      const result = await ingestService.ingest({
        provider: MOCK_PROVIDER_NAME,
        providerEventId: eventId,
        eventType: typeof parsed.type === 'string' ? parsed.type : undefined,
        rawBody,
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([k, v]) => [k, String(v ?? '')])
        ),
        signature: {
          secret: mockWebhookSecret,
          timestampMs: timestamp,
          signature,
        },
      });
      return reply.code(200).send({ received: true, duplicate: result.duplicate });
    });
  });
}
