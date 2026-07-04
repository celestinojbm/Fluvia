import type { FastifyRequest } from 'fastify';
import type { Pool } from '@fluvia/db';
import type { AuthService } from '@fluvia/auth';
import { InvalidSessionError } from '@fluvia/auth';
import {
  hasPermission,
  hashApiKeySecret,
  IdentityService,
  InsufficientPermissionError,
  InsufficientScopeError,
  InvalidApiKeyError,
  OrganizationNotFoundError,
  type ApiKeyScope,
  type Permission,
  type Role,
} from '@fluvia/identity';

declare module 'fastify' {
  interface FastifyRequest {
    identity?: { userId: string; sessionId: string };
    org?: { organizationId: string; role: Role };
    apiKey?: {
      tenantId: string;
      apiKeyId: string;
      scopes: string[];
      environment: string;
    };
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function bearer(req: FastifyRequest): string | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return undefined;
  return header.slice('Bearer '.length).trim();
}

export interface SecurityDeps {
  authService: AuthService;
  identityService: IdentityService;
  appPool: Pool;
}

/**
 * Dos planos de autenticacion, nunca intercambiables:
 *  - session(): dashboard-plane. Bearer fluvia_sess_* -> usuario; el rol se
 *    resuelve POR organizacion via membresia (RLS aplica en la consulta).
 *  - apiKey(scopes): integration-plane. Bearer fluvia_sk_* -> tenant + scopes.
 *    Una API key jamas alcanza endpoints de gestion (no existe scope para ello).
 */
export function createSecurity(deps: SecurityDeps) {
  return {
    session: async (req: FastifyRequest): Promise<void> => {
      const token = bearer(req);
      if (!token || !token.startsWith('fluvia_sess_')) throw new InvalidSessionError();
      const identity = await deps.authService.authenticateSession(token);
      req.identity = { userId: identity.userId, sessionId: identity.sessionId };
    },

    org(permission: Permission) {
      return async (req: FastifyRequest): Promise<void> => {
        const { orgId } = req.params as { orgId?: string };
        // Un orgId ajeno y uno inexistente deben ser indistinguibles (404).
        if (!orgId || !UUID_RE.test(orgId)) throw new OrganizationNotFoundError();
        const role = await deps.identityService.getMemberRole(orgId, req.identity!.userId);
        if (!role) throw new OrganizationNotFoundError();
        if (!hasPermission(role as Role, permission)) {
          throw new InsufficientPermissionError(permission);
        }
        req.org = { organizationId: orgId, role: role as Role };
      };
    },

    apiKey(requiredScopes: readonly ApiKeyScope[]) {
      return async (req: FastifyRequest): Promise<void> => {
        const token = bearer(req);
        if (!token || !token.startsWith('fluvia_sk_')) throw new InvalidApiKeyError();
        const res = await deps.appPool.query<{
          tenant_id: string;
          api_key_id: string;
          scopes: string[];
          environment: string;
        }>('SELECT * FROM authenticate_api_key($1)', [hashApiKeySecret(token)]);
        const row = res.rows[0];
        if (!row) throw new InvalidApiKeyError();
        for (const scope of requiredScopes) {
          if (!row.scopes.includes(scope)) throw new InsufficientScopeError(scope);
        }
        req.apiKey = {
          tenantId: row.tenant_id,
          apiKeyId: row.api_key_id,
          scopes: row.scopes,
          environment: row.environment,
        };
      };
    },
  };
}

export type Security = ReturnType<typeof createSecurity>;
