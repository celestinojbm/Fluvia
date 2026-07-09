import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthService } from '@fluvia/auth';
import type { AuditContext, AuditReader } from '@fluvia/audit';
import {
  CreateApiKeySchema,
  CreateMerchantSchema,
  UpdateMerchantSchema,
  type ApiKeyService,
  type IdentityService,
} from '@fluvia/identity';
import type { Security } from '../security.js';

export interface OrganizationRoutesDeps {
  security: Security;
  authService: AuthService;
  identityService: IdentityService;
  apiKeyService: ApiKeyService;
  auditReader: AuditReader;
}

/** Contexto de auditoria derivado del request autenticado por sesion. */
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

const AuditQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    before: z.coerce.number().int().positive().optional(),
  })
  .strict();

// F6 (revisión de seguridad): valida los IDs de ruta como UUID ANTES de tocar la
// BD. Sin esto, un id malformado (`.../merchants/not-a-uuid`) llegaba a un
// `WHERE id = $1` sobre una columna uuid → error 22P02 → 500 `internal_error`
// (en vez del 400 `validation_error` uniforme, y un oráculo débil 500-vs-404).
const MerchantParams = z.object({ merchantId: z.string().uuid() });
const ApiKeyParams = z.object({ apiKeyId: z.string().uuid() });

/**
 * Plano de dashboard (sesion + rol por organizacion). Toda ruta bajo
 * /v1/organizations/:orgId pasa por session() y org(permiso): BOLA se corta
 * en el middleware, no en cada handler.
 */
export function registerOrganizationRoutes(
  app: FastifyInstance,
  { security, authService, identityService, apiKeyService, auditReader }: OrganizationRoutesDeps
): void {
  app.get('/v1/organizations', { preHandler: [security.session] }, async (req) => {
    const memberships = await authService.listMemberships(req.identity!.userId);
    return {
      organizations: memberships.map((m) => ({
        organization_id: m.organizationId,
        name: m.organizationName,
        slug: m.organizationSlug,
        role: m.role,
      })),
    };
  });

  app.get(
    '/v1/organizations/:orgId',
    { preHandler: [security.session, security.org('org:read')] },
    async (req) => {
      const org = await identityService.getOrganization(req.org!.organizationId);
      return { id: org.id, name: org.name, slug: org.slug, created_at: org.createdAt };
    }
  );

  app.get(
    '/v1/organizations/:orgId/members',
    { preHandler: [security.session, security.org('members:read')] },
    async (req) => {
      const members = await identityService.listMembers(req.org!.organizationId);
      return {
        members: members.map((m) => ({
          membership_id: m.membershipId,
          user_id: m.userId,
          email: m.email,
          role: m.role,
          since: m.since,
        })),
      };
    }
  );

  app.post(
    '/v1/organizations/:orgId/merchants',
    { preHandler: [security.session, security.org('merchants:write')] },
    async (req, reply) => {
      const input = CreateMerchantSchema.parse(req.body);
      const merchant = await identityService.createMerchant(
        req.org!.organizationId,
        input,
        auditContext(req)
      );
      return reply.code(201).send(merchant);
    }
  );

  app.get(
    '/v1/organizations/:orgId/merchants',
    { preHandler: [security.session, security.org('merchants:read')] },
    async (req) => ({ merchants: await identityService.listMerchants(req.org!.organizationId) })
  );

  app.get(
    '/v1/organizations/:orgId/merchants/:merchantId',
    { preHandler: [security.session, security.org('merchants:read')] },
    async (req) => {
      const { merchantId } = MerchantParams.parse(req.params);
      return identityService.getMerchant(req.org!.organizationId, merchantId);
    }
  );

  app.patch(
    '/v1/organizations/:orgId/merchants/:merchantId',
    { preHandler: [security.session, security.org('merchants:write')] },
    async (req) => {
      const { merchantId } = MerchantParams.parse(req.params);
      const input = UpdateMerchantSchema.parse(req.body);
      return identityService.updateMerchant(
        req.org!.organizationId,
        merchantId,
        input,
        auditContext(req)
      );
    }
  );

  app.post(
    '/v1/organizations/:orgId/api-keys',
    // F1-04b: crear keys es accion sensible -> step-up MFA si esta habilitado.
    { preHandler: [security.session, security.org('keys:manage'), security.stepUp] },
    async (req, reply) => {
      const input = CreateApiKeySchema.parse(req.body);
      const created = await apiKeyService.create(req.org!.organizationId, input, auditContext(req));
      return reply.code(201).send({
        id: created.id,
        // Unica vez que el secreto viaja; no vuelve a ser recuperable.
        secret: created.secret,
        key_prefix: created.keyPrefix,
        label: created.label,
        scopes: created.scopes,
        environment: created.environment,
      });
    }
  );

  app.get(
    '/v1/organizations/:orgId/api-keys',
    { preHandler: [security.session, security.org('keys:read')] },
    async (req) => {
      const keys = await apiKeyService.list(req.org!.organizationId);
      return {
        api_keys: keys.map((k) => ({
          id: k.id,
          label: k.label,
          key_prefix: k.keyPrefix,
          scopes: k.scopes,
          environment: k.environment,
          created_at: k.createdAt,
          last_used_at: k.lastUsedAt,
          revoked_at: k.revokedAt,
        })),
      };
    }
  );

  app.post(
    '/v1/organizations/:orgId/api-keys/:apiKeyId/revoke',
    { preHandler: [security.session, security.org('keys:manage'), security.stepUp] },
    async (req, reply) => {
      const { apiKeyId } = ApiKeyParams.parse(req.params);
      await apiKeyService.revoke(req.org!.organizationId, apiKeyId, auditContext(req));
      return reply.code(204).send();
    }
  );

  app.get(
    '/v1/organizations/:orgId/audit-events',
    { preHandler: [security.session, security.org('audit:read')] },
    async (req) => {
      const query = AuditQuerySchema.parse(req.query);
      const events = await auditReader.list(req.org!.organizationId, query);
      return {
        audit_events: events.map((e) => ({
          id: e.id,
          actor_type: e.actorType,
          actor_id: e.actorId,
          auth_method: e.authMethod,
          action: e.action,
          resource_type: e.resourceType,
          resource_id: e.resourceId,
          result: e.result,
          risk_level: e.riskLevel,
          reason: e.reason,
          request_id: e.requestId,
          created_at: e.createdAt,
        })),
        next_before: events.length > 0 ? events[events.length - 1]!.id : null,
      };
    }
  );
}

/**
 * Plano de integracion (API key + scopes). Primer recurso real: /v1/account.
 */
export function registerAccountRoutes(
  app: FastifyInstance,
  { security, identityService }: { security: Security; identityService: IdentityService }
): void {
  app.get('/v1/account', { preHandler: [security.apiKey(['read'])] }, async (req) => {
    const tenantId = req.apiKey!.tenantId;
    const [org, merchants] = await Promise.all([
      identityService.getOrganization(tenantId),
      identityService.listMerchants(tenantId),
    ]);
    return {
      organization: { id: org.id, name: org.name, slug: org.slug },
      merchants,
      environment: req.apiKey!.environment,
    };
  });
}
