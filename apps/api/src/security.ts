import type { FastifyRequest } from 'fastify';
import type { Pool } from '@fluvia/db';
import type { AuthService } from '@fluvia/auth';
import { InvalidSessionError, StepUpRequiredError } from '@fluvia/auth';
import {
  DEV_API_KEY_HMAC_SECRET_HEX,
  hasPermission,
  hashApiKeySecret,
  hmacApiKeySecret,
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
    identity?: {
      userId: string;
      sessionId: string;
      mfaEnabled: boolean;
      mfaVerifiedAt: Date | null;
      passwordVerifiedAt: Date | null;
    };
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
  /** Pepper HMAC de API keys (AUD-P2-015). Default SOLO local. */
  apiKeyHmacSecretHex?: string;
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
      req.identity = {
        userId: identity.userId,
        sessionId: identity.sessionId,
        mfaEnabled: identity.mfaEnabled,
        mfaVerifiedAt: identity.mfaVerifiedAt,
        passwordVerifiedAt: identity.passwordVerifiedAt,
      };
    },

    /**
     * F1-04b + TM-02: STEP-UP para acciones sensibles (keys:manage). La sesion
     * debe traer una re-autenticacion RECIENTE (authService.stepUpMaxAgeMs):
     *  - con MFA habilitado, verificacion TOTP (/v1/auth/mfa/step-up) — el
     *    password NO sustituye al factor fuerte;
     *  - sin MFA, re-autenticacion por password (/v1/auth/step-up/password).
     * TM-02 cierra el hueco anterior (los usuarios sin MFA no se bloqueaban:
     * una sesion secuestrada acunaba keys sin prueba fresca). El sandbox
     * compartido ademas exigira enrolamiento MFA (PEND-006).
     */
    stepUp: async (req: FastifyRequest): Promise<void> => {
      const identity = req.identity!;
      const maxAge = deps.authService.stepUpMaxAgeMs;
      const fresh = (t: Date | null): boolean => t !== null && Date.now() - t.getTime() <= maxAge;
      const ok = identity.mfaEnabled
        ? fresh(identity.mfaVerifiedAt)
        : fresh(identity.passwordVerifiedAt);
      if (!ok) throw new StepUpRequiredError();
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
        // AUD-P2-015: se computan AMBOS hashes; la funcion definer autentica
        // v2 (HMAC) o v1 (sha256 legado) y promueve v1->v2 en el mismo paso.
        const pepper = deps.apiKeyHmacSecretHex ?? DEV_API_KEY_HMAC_SECRET_HEX;
        const res = await deps.appPool.query<{
          tenant_id: string;
          api_key_id: string;
          scopes: string[];
          environment: string;
        }>('SELECT * FROM authenticate_api_key($1, $2)', [
          hmacApiKeySecret(pepper, token),
          hashApiKeySecret(token),
        ]);
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
