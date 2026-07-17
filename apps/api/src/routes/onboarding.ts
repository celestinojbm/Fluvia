import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuditContext } from '@fluvia/audit';
import {
  CreateMerchantSchema,
  SLUG_RE,
  type IdentityService,
  type OrganizationOnboardingService,
} from '@fluvia/identity';
import type { PostingService } from '@fluvia/ledger';
import type { Security } from '../security.js';

export interface OnboardingRoutesDeps {
  security: Security;
  identityService: IdentityService;
  postingService: PostingService;
  /**
   * Fachada del plano de PLATAFORMA para crear la organizacion (ya cableada
   * en app.ts — las rutas jamas tocan pools administrativos). Opcional: sin
   * ella, `POST /v1/organizations` no se registra (404); la ruta de merchant
   * onboarding (plano tenant) no la necesita.
   */
  organizationOnboarding?: OrganizationOnboardingService;
}

/** Contexto de auditoria del request autenticado por sesion (actor humano). */
function auditContext(req: FastifyRequest): AuditContext {
  return {
    actorType: 'user',
    actorId: req.identity!.userId,
    authMethod: 'session',
    requestId: String(req.id),
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  };
}

// Body del onboarding de organizacion: el userId JAMAS viene del body (sale de
// la sesion). Reutiliza la misma validacion/normalizacion del dominio.
const OnboardingOrganizationBody = z
  .object({
    organizationName: z.string().trim().min(2).max(120),
    slug: z.string().regex(SLUG_RE, 'slug must be lowercase alphanumeric with hyphens'),
  })
  .strict();

/**
 * F6.5C2 — rutas de ONBOARDING (plano de sesion; una API key jamas llega aqui:
 * `security.session` rechaza tokens que no sean `fluvia_sess_*`).
 *
 *  - `POST /v1/organizations` (Paso A, plano de plataforma): organizacion +
 *    membership owner + auditoria atomicos, con idempotencia natural.
 *  - `POST /v1/organizations/:orgId/onboarding/merchant` (Paso B, plano
 *    tenant): merchant de onboarding (cardinalidad 1 por org, advisory lock)
 *    seguido de `ensureChart` idempotente FUERA de la transaccion del
 *    merchant. No existe transaccion distribuida entre ambos planos.
 */
export function registerOnboardingRoutes(
  app: FastifyInstance,
  { security, identityService, postingService, organizationOnboarding }: OnboardingRoutesDeps
): void {
  if (organizationOnboarding) {
    app.post('/v1/organizations', { preHandler: [security.session] }, async (req, reply) => {
      const body = OnboardingOrganizationBody.parse(req.body);
      // La verificacion de email se re-comprueba DENTRO de la transaccion del
      // servicio (defensa en profundidad: el login ya la exige).
      const result = await organizationOnboarding.createForUser(
        {
          userId: req.identity!.userId,
          organizationName: body.organizationName,
          slug: body.slug,
        },
        auditContext(req)
      );
      return reply.code(result.replayed ? 200 : 201).send({
        organization: {
          id: result.organization.id,
          name: result.organization.name,
          slug: result.organization.slug,
        },
        membership: { role: result.membership.role },
        replayed: result.replayed,
      });
    });
  }

  app.post(
    '/v1/organizations/:orgId/onboarding/merchant',
    // Mismo permiso que la creacion general de merchant (`merchants:write`);
    // el guard org() hace el aislamiento cross-tenant indistinguible (404).
    { preHandler: [security.session, security.org('merchants:write')] },
    async (req, reply) => {
      const input = CreateMerchantSchema.parse(req.body);
      const tenantId = req.org!.organizationId;
      const result = await identityService.ensureMerchantForOnboarding(
        tenantId,
        input,
        auditContext(req)
      );
      // Paso posterior idempotente: si falla, organizacion y merchant quedan
      // VALIDOS y el retry recupera el merchant (replay) y re-ejecuta el chart.
      await postingService.ensureChart(
        tenantId,
        result.merchant.id,
        result.merchant.defaultCurrency
      );
      return reply.code(result.replayed ? 200 : 201).send({
        merchant: {
          id: result.merchant.id,
          name: result.merchant.name,
          country: result.merchant.country,
          defaultCurrency: result.merchant.defaultCurrency,
        },
        chartReady: true,
        replayed: result.replayed,
      });
    }
  );
}
