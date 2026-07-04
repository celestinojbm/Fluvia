import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { AppConfig } from '@fluvia/config';
import type { Pool } from '@fluvia/db';
import type { AuthService } from '@fluvia/auth';
import { AuditReader } from '@fluvia/audit';
import type { ApiKeyService, IdentityService } from '@fluvia/identity';
import { registerAuthRoutes } from './routes/auth.js';
import { registerAccountRoutes, registerOrganizationRoutes } from './routes/organizations.js';
import { createSecurity } from './security.js';
import { DOMAIN_ERROR_CODES, ERROR_CATALOG, errorBody } from './error-catalog.js';

export interface BuildAppOptions {
  config: AppConfig;
  /** Pool con rol fluvia_app (RLS forzado). */
  appPool: Pool;
  /** Servicio de autenticacion (pool fluvia_auth). Opcional en tests de plataforma. */
  authService?: AuthService;
  identityService?: IdentityService;
  apiKeyService?: ApiKeyService;
}

// F1-08: la taxonomia vive en error-catalog.ts (catalogo versionado con
// contract test). Este archivo solo enruta hacia ella.

/**
 * Construye la instancia Fastify del API (F1-01).
 *
 * Solo plataforma: health/readiness, correlation id, redaccion de secretos
 * en logs y el sobre de error estable minimo. Los recursos de negocio llegan
 * con sus dominios (F3+); la taxonomia completa de errores es F1-08.
 */
export function buildApp({
  config,
  appPool,
  authService,
  identityService,
  apiKeyService,
}: BuildAppOptions): FastifyInstance {
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

  if (authService) {
    registerAuthRoutes(app, {
      authService,
      exposeVerificationToken: config.env === 'local' || config.env === 'test',
    });
  }

  if (authService && identityService && apiKeyService) {
    const security = createSecurity({ authService, identityService, appPool });
    const auditReader = new AuditReader(appPool);
    registerOrganizationRoutes(app, {
      security,
      authService,
      identityService,
      apiKeyService,
      auditReader,
    });
    registerAccountRoutes(app, { security, identityService });
  }

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send(errorBody('not_found', req.id));
  });

  // F1-08: TODA respuesta de error sale del catalogo. El message interno de
  // los errores de dominio va SOLO a logs (AUD-P2-009); el cliente recibe el
  // texto publico y estable del catalogo.
  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(ERROR_CATALOG.validation_error.status).send(
        errorBody(
          'validation_error',
          req.id,
          err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
        )
      );
    }

    const code = DOMAIN_ERROR_CODES[err.name];
    if (code) {
      req.log.info({ errName: err.name, errMessage: err.message, code }, 'domain error');
      return reply.code(ERROR_CATALOG[code].status).send(errorBody(code, req.id));
    }

    // Errores del propio Fastify (forma del request), tambien via catalogo.
    if (err.statusCode === 413) {
      return reply.code(413).send(errorBody('payload_too_large', req.id));
    }
    if (err.statusCode === 415) {
      return reply.code(415).send(errorBody('unsupported_media_type', req.id));
    }
    if (
      err.statusCode === 400 &&
      typeof err.code === 'string' &&
      err.code.startsWith('FST_ERR_CTP')
    ) {
      return reply.code(400).send(errorBody('invalid_json', req.id));
    }
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      req.log.warn({ err }, 'unmapped 4xx request error');
      return reply.code(400).send(errorBody('bad_request', req.id));
    }

    // 5xx: jamas filtra detalle interno al cliente.
    req.log.error({ err }, 'request failed');
    reply.code(500).send(errorBody('internal_error', req.id));
  });

  return app;
}
