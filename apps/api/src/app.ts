import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { AppConfig } from '@fluvia/config';
import type { Pool } from '@fluvia/db';
import type { AuthService } from '@fluvia/auth';
import type { ApiKeyService, IdentityService } from '@fluvia/identity';
import { registerAuthRoutes } from './routes/auth.js';
import { registerAccountRoutes, registerOrganizationRoutes } from './routes/organizations.js';
import { createSecurity } from './security.js';

export interface BuildAppOptions {
  config: AppConfig;
  /** Pool con rol fluvia_app (RLS forzado). */
  appPool: Pool;
  /** Servicio de autenticacion (pool fluvia_auth). Opcional en tests de plataforma. */
  authService?: AuthService;
  identityService?: IdentityService;
  apiKeyService?: ApiKeyService;
}

/**
 * Mapa de errores de dominio -> HTTP. Baseline previa a la taxonomia completa
 * (F1-08). La clave es el nombre de la clase de error de dominio.
 */
const DOMAIN_ERROR_HTTP: Record<string, { status: number; code: string }> = {
  EmailTakenError: { status: 409, code: 'email_taken' },
  InvalidCredentialsError: { status: 401, code: 'invalid_credentials' },
  EmailNotVerifiedError: { status: 403, code: 'email_not_verified' },
  AccountLockedError: { status: 423, code: 'account_locked' },
  InvalidSessionError: { status: 401, code: 'invalid_session' },
  InvalidVerificationTokenError: { status: 400, code: 'invalid_verification_token' },
  // Identidad / RBAC / API keys (F1-03, F1-04c). Los not-found cross-tenant
  // son indistinguibles de los inexistentes por diseño (anti-enumeracion).
  OrganizationNotFoundError: { status: 404, code: 'not_found' },
  MerchantNotFoundError: { status: 404, code: 'not_found' },
  ApiKeyNotFoundError: { status: 404, code: 'not_found' },
  MerchantNameTakenError: { status: 409, code: 'merchant_name_taken' },
  OrganizationSlugTakenError: { status: 409, code: 'organization_slug_taken' },
  InsufficientPermissionError: { status: 403, code: 'insufficient_permissions' },
  InvalidApiKeyError: { status: 401, code: 'invalid_api_key' },
  InsufficientScopeError: { status: 403, code: 'insufficient_scope' },
};

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
    registerOrganizationRoutes(app, { security, authService, identityService, apiKeyService });
    registerAccountRoutes(app, { security, identityService });
  }

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({
      error: { code: 'not_found', message: 'Resource not found', request_id: req.id },
    });
  });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: 'validation_error',
          message: 'Invalid request payload',
          details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          request_id: req.id,
        },
      });
    }

    const mapped = DOMAIN_ERROR_HTTP[err.name];
    if (mapped) {
      req.log.info({ errName: err.name }, 'domain error');
      return reply.code(mapped.status).send({
        error: { code: mapped.code, message: err.message, request_id: req.id },
      });
    }

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
