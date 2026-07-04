import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AuthService } from '@fluvia/auth';
import { LoginSchema, RegisterSchema, VerifyEmailSchema } from '@fluvia/auth';
import { InvalidSessionError } from '@fluvia/auth';

export interface AuthRoutesOptions {
  authService: AuthService;
  /** Solo local/test: expone el token de verificacion en la respuesta de registro. */
  exposeVerificationToken: boolean;
}

function bearerToken(req: FastifyRequest): string {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw new InvalidSessionError();
  return header.slice('Bearer '.length).trim();
}

export function registerAuthRoutes(
  app: FastifyInstance,
  { authService, exposeVerificationToken }: AuthRoutesOptions
): void {
  app.post('/v1/auth/register', async (req, reply) => {
    const body = RegisterSchema.parse(req.body);
    const result = await authService.register(body);
    return reply.code(201).send({
      user_id: result.userId,
      email_verification: 'pending',
      // El canal de correo llega con el motor de webhooks/email (F3). Hasta
      // entonces el token SOLO se expone en entornos local/test.
      ...(exposeVerificationToken ? { verification_token: result.verificationToken } : {}),
    });
  });

  app.post('/v1/auth/verify-email', async (req) => {
    const body = VerifyEmailSchema.parse(req.body);
    await authService.verifyEmail(body);
    return { verified: true };
  });

  app.post('/v1/auth/login', async (req) => {
    const body = LoginSchema.parse(req.body);
    const result = await authService.login(body, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    return {
      session_token: result.sessionToken,
      expires_at: result.expiresAt.toISOString(),
    };
  });

  app.post('/v1/auth/logout', async (req, reply) => {
    await authService.logout(bearerToken(req));
    return reply.code(204).send();
  });

  app.get('/v1/auth/session', async (req) => {
    const identity = await authService.authenticateSession(bearerToken(req));
    const memberships = await authService.listMemberships(identity.userId);
    return {
      user_id: identity.userId,
      memberships: memberships.map((m) => ({
        organization_id: m.organizationId,
        organization_name: m.organizationName,
        organization_slug: m.organizationSlug,
        role: m.role,
      })),
    };
  });
}
