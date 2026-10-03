import type { FastifyInstance } from 'fastify';
import { FixedWindowLimiter, ipKey, rateLimit, type RateLimiter } from '../rate-limit.js';
import type { FxService } from '../fx/service.js';
import { snake } from './wire.js';

/**
 * Tasas de REFERENCIA (públicas): BCV (USD/Bs, EUR/Bs), USDT/USD de mercado y
 * la referencia cruzada USDT/Bs. Solo lectura de la caché compartida; esta
 * ruta NUNCA consulta a un proveedor externo (lo hace el refresco).
 * Informativas: no cobran, no convierten fondos ni crean cuentas.
 */
export function registerFxRoutes(
  app: FastifyInstance,
  deps: { fx: FxService; limiter?: RateLimiter }
): void {
  const limited = {
    preHandler: rateLimit(deps.limiter ?? new FixedWindowLimiter(), [
      { keyOf: ipKey('fx:ip'), rule: { max: 240, windowMs: 60_000 } },
    ]),
  };
  app.get('/v1/fx/rates', limited, async (_req, reply) => {
    reply.header('cache-control', 'public, max-age=30');
    return snake(await deps.fx.view());
  });
}
