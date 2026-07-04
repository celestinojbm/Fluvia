import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { AppConfig } from '@fluvia/config';
import type { Pool } from '@fluvia/db';

export interface BuildAppOptions {
  config: AppConfig;
  /** Pool con rol fluvia_app (RLS forzado). */
  appPool: Pool;
}

/**
 * Construye la instancia Fastify del API (F1-01).
 *
 * Solo plataforma: health/readiness, correlation id, redaccion de secretos
 * en logs y el sobre de error estable minimo. Los recursos de negocio llegan
 * con sus dominios (F3+); la taxonomia completa de errores es F1-08.
 */
export function buildApp({ config, appPool }: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: {
        paths: ['req.headers.authorization', 'req.headers["x-api-key"]', 'req.headers.cookie'],
        censor: '[REDACTED]',
      },
    },
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      const value = Array.isArray(incoming) ? incoming[0] : incoming;
      // Se acepta el id entrante solo si es corto y simple (anti log-injection).
      return value && /^[A-Za-z0-9._-]{1,64}$/.test(value) ? value : randomUUID();
    },
    bodyLimit: 1024 * 1024,
  });

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  app.get('/health', async () => ({
    status: 'ok',
    env: config.env,
    uptime_seconds: Math.round(process.uptime()),
  }));

  app.get('/ready', async (req, reply) => {
    try {
      await appPool.query('SELECT 1');
      return { status: 'ready' };
    } catch (err) {
      req.log.error({ err }, 'readiness check failed: database unreachable');
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({
      error: { code: 'not_found', message: 'Resource not found', request_id: req.id },
    });
  });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    req.log.error({ err }, 'request failed');
    // Los errores 5xx jamas filtran detalle interno al cliente.
    reply.code(status).send({
      error: {
        code: status >= 500 ? 'internal_error' : (err.code ?? 'request_error'),
        message: status >= 500 ? 'Internal server error' : err.message,
        request_id: req.id,
      },
    });
  });

  return app;
}
