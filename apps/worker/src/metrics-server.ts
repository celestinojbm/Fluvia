import { createServer, type Server } from 'node:http';
import { METRICS_CONTENT_TYPE, type MetricsRegistry } from '@fluvia/observability';

export interface MetricsServerOptions {
  registry: MetricsRegistry;
  /** Estado incluido en GET /health (heartbeats, tareas activas, etc.). */
  healthInfo: () => Record<string, unknown>;
}

/**
 * Endpoint de observabilidad del worker (F1-07). El worker no expone API de
 * negocio: este servidor SOLO sirve /health y /metrics (agregados anonimos)
 * para scrape/probes. Cualquier otra ruta es 404 sin cuerpo informativo.
 */
export function createMetricsServer(opts: MetricsServerOptions): Server {
  return createServer((req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405).end();
      return;
    }
    if (req.url === '/health') {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ status: 'ok', ...opts.healthInfo() }));
      return;
    }
    if (req.url === '/metrics') {
      res.writeHead(200, { 'content-type': METRICS_CONTENT_TYPE }).end(opts.registry.render());
      return;
    }
    res.writeHead(404).end();
  });
}
