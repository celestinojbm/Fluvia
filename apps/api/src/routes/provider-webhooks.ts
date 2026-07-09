import type { FastifyInstance } from 'fastify';
import { InboxIngestService } from '@fluvia/inbox';
import { MOCK_PROVIDER_NAME } from '@fluvia/payments-core';
import {
  FixedWindowLimiter,
  ipKey,
  rateLimit,
  type RateLimiter,
  type RateRule,
} from '../rate-limit.js';

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
 *
 * Rate limit (threat model §5): el endpoint es publico y sin API key — sin
 * limite, un flooder gasta buffer, parseo y HMAC gratis. El limite por IP
 * corre en onRequest (ANTES de bufferizar/parsear el body y de verificar la
 * firma); un 429 al proveedor legitimo NO pierde eventos: todo proveedor
 * reintenta ante non-2xx y la dedup por (provider, provider_event_id)
 * absorbe la reentrega.
 *
 * LIMITE DE TOPOLOGIA (registrado en threat model §5): la clave es `req.ip`
 * = peer del socket. Correcto con el API directamente expuesto (sandbox
 * docker-compose actual); DETRAS de un proxy/LB todas las requests comparten
 * la IP del proxy — un solo bucket global que un flooder sin firma agotaria
 * para todos. Antes de un despliegue con proxy (PEND-006) hay que configurar
 * `trustProxy` ACOTADO a los hops reales del LB (un `trustProxy: true`
 * ingenuo seria peor: X-Forwarded-For spoofeable = bypass + starvation
 * dirigida). Aplica igual al rate limit de /v1/auth/*.
 */

export interface ProviderWebhookRateLimits {
  ingestPerIp: RateRule;
}

/** Default Nivel C: ~2 rps sostenidos por IP — holgado para las rafagas de
 * reintento de un proveedor real, letal para un flooder de una sola IP. */
export const DEFAULT_PROVIDER_WEBHOOK_RATE_LIMITS: ProviderWebhookRateLimits = {
  ingestPerIp: { max: 120, windowMs: 60_000 },
};

export interface ProviderWebhookRoutesOptions {
  ingestService: InboxIngestService;
  mockWebhookSecret: string;
  rateLimits?: ProviderWebhookRateLimits;
  /** TM-03: backend del limiter. Default: ventana fija in-memory (mono-instancia);
   *  los despliegues compartidos inyectan `RedisFixedWindowLimiter`. */
  limiter?: RateLimiter;
}

export function registerProviderWebhookRoutes(
  app: FastifyInstance,
  { ingestService, mockWebhookSecret, rateLimits, limiter: injected }: ProviderWebhookRoutesOptions
): void {
  const limits = rateLimits ?? DEFAULT_PROVIDER_WEBHOOK_RATE_LIMITS;
  const limiter = injected ?? new FixedWindowLimiter();

  void app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'string', bodyLimit: 1024 * 1024 },
      (_req, body, done) => {
        done(null, body);
      }
    );

    scope.post(
      '/v1/providers/mock/webhook',
      {
        onRequest: rateLimit(limiter, [
          { keyOf: ipKey('provider-webhook:ip'), rule: limits.ingestPerIp },
        ]),
      },
      async (req, reply) => {
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
      }
    );
  });
}
