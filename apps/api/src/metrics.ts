import type { FastifyInstance } from 'fastify';
import {
  DEFAULT_DURATION_BUCKETS,
  METRICS_CONTENT_TYPE,
  MetricsRegistry,
} from '@fluvia/observability';

declare module 'fastify' {
  interface FastifyRequest {
    metricsStartNs?: bigint;
  }
}

/**
 * Instrumentacion HTTP del API (F1-07).
 *
 * Labels SIEMPRE de cardinalidad acotada: la ruta es la PLANTILLA registrada
 * (`/v1/organizations/:orgId`), jamas la URL cruda; los requests que no
 * matchean ninguna ruta colapsan en `unmatched` (un scanner de paths no debe
 * poder inflar la cardinalidad de /metrics). Nada de labels por tenant.
 *
 * /metrics expone SOLO agregados anonimos. En sandbox el endpoint es abierto;
 * en despliegues reales debe quedar en la red interna de scrape (documentado
 * en observability.md — Nivel C hasta F6).
 */
export function registerMetrics(app: FastifyInstance, registry: MetricsRegistry): void {
  const requests = registry.counter(
    'fluvia_http_requests_total',
    'Peticiones HTTP atendidas por el API',
    ['method', 'route', 'status']
  );
  const duration = registry.histogram(
    'fluvia_http_request_duration_seconds',
    'Duracion de peticiones HTTP del API en segundos',
    ['method', 'route'],
    DEFAULT_DURATION_BUCKETS
  );

  app.addHook('onRequest', async (req) => {
    req.metricsStartNs = process.hrtime.bigint();
  });

  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions.url ?? 'unmatched';
    requests.inc({ method: req.method, route, status: String(reply.statusCode) });
    if (req.metricsStartNs !== undefined) {
      const seconds = Number(process.hrtime.bigint() - req.metricsStartNs) / 1e9;
      duration.observe({ method: req.method, route }, seconds);
    }
  });

  app.get('/metrics', async (_req, reply) => {
    return reply.type(METRICS_CONTENT_TYPE).send(registry.render());
  });
}
