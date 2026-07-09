import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AuthService } from '@fluvia/auth';
import {
  LoginSchema,
  MfaCodeOnlySchema,
  MfaVerifySchema,
  RegisterSchema,
  StepUpPasswordSchema,
  VerifyEmailSchema,
} from '@fluvia/auth';
import { InvalidSessionError } from '@fluvia/auth';
import {
  FixedWindowLimiter,
  emailKey,
  ipKey,
  rateLimit,
  type RateLimiter,
  type RateRule,
} from '../rate-limit.js';

export interface AuthRateLimits {
  loginPerEmail: RateRule;
  loginPerIp: RateRule;
  registerPerIp: RateRule;
  mfaPerIp: RateRule;
}

/** Defaults Nivel C (sandbox); los tests inyectan ventanas cortas. */
export const DEFAULT_AUTH_RATE_LIMITS: AuthRateLimits = {
  loginPerEmail: { max: 5, windowMs: 60_000 },
  loginPerIp: { max: 20, windowMs: 60_000 },
  registerPerIp: { max: 5, windowMs: 60_000 },
  mfaPerIp: { max: 20, windowMs: 60_000 },
};

export interface AuthRoutesOptions {
  authService: AuthService;
  /** Solo local/test: expone el token de verificacion en la respuesta de registro. */
  exposeVerificationToken: boolean;
  rateLimits?: AuthRateLimits;
  /** TM-03: backend del limiter. Default: ventana fija in-memory (mono-instancia);
   *  los despliegues compartidos inyectan `RedisFixedWindowLimiter`. */
  limiter?: RateLimiter;
}

function bearerToken(req: FastifyRequest): string {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw new InvalidSessionError();
  return header.slice('Bearer '.length).trim();
}

function meta(req: FastifyRequest) {
  return { ip: req.ip, userAgent: req.headers['user-agent'], requestId: String(req.id) };
}

export function registerAuthRoutes(
  app: FastifyInstance,
  { authService, exposeVerificationToken, rateLimits, limiter: injected }: AuthRoutesOptions
): void {
  const limits = rateLimits ?? DEFAULT_AUTH_RATE_LIMITS;
  const limiter = injected ?? new FixedWindowLimiter();

  app.post(
    '/v1/auth/register',
    {
      preHandler: rateLimit(limiter, [{ keyOf: ipKey('register:ip'), rule: limits.registerPerIp }]),
    },
    async (req, reply) => {
      const body = RegisterSchema.parse(req.body);
      const result = await authService.register(body);
      return reply.code(201).send({
        user_id: result.userId,
        email_verification: 'pending',
        // El canal de correo llega con el motor de webhooks/email (F3). Hasta
        // entonces el token SOLO se expone en entornos local/test.
        ...(exposeVerificationToken ? { verification_token: result.verificationToken } : {}),
      });
    }
  );

  app.post('/v1/auth/verify-email', async (req) => {
    const body = VerifyEmailSchema.parse(req.body);
    await authService.verifyEmail(body);
    return { verified: true };
  });

  app.post(
    '/v1/auth/login',
    {
      preHandler: rateLimit(limiter, [
        // Por email: frena el ataque a UNA cuenta desde muchas IPs.
        { keyOf: emailKey('login:email'), rule: limits.loginPerEmail },
        // Por IP: frena el barrido de muchas cuentas desde una IP.
        { keyOf: ipKey('login:ip'), rule: limits.loginPerIp },
      ]),
    },
    async (req) => {
      const body = LoginSchema.parse(req.body);
      const outcome = await authService.login(body, meta(req));
      if (outcome.mfaRequired) {
        return {
          mfa_required: true,
          challenge_token: outcome.challengeToken,
          expires_at: outcome.challengeExpiresAt.toISOString(),
        };
      }
      return {
        mfa_required: false,
        session_token: outcome.sessionToken,
        expires_at: outcome.expiresAt.toISOString(),
      };
    }
  );

  // Canje del reto MFA por sesion (publico: el reto ES la credencial).
  app.post(
    '/v1/auth/mfa/verify',
    { preHandler: rateLimit(limiter, [{ keyOf: ipKey('mfa:ip'), rule: limits.mfaPerIp }]) },
    async (req) => {
      const body = MfaVerifySchema.parse(req.body);
      const result = await authService.verifyMfaChallenge(body, meta(req));
      return {
        session_token: result.sessionToken,
        expires_at: result.expiresAt.toISOString(),
      };
    }
  );

  // Enrolamiento (requiere sesion + STEP-UP fresco): setup -> activate -> enabled.
  // F6 (revisión de seguridad, TM-02): enrolar/activar/deshabilitar MFA es una
  // operación de credenciales sensible — exige re-autenticación reciente (password
  // fresco para usuarios sin MFA; TOTP fresco para los que ya lo tienen), igual que
  // acuñar API keys. Sin esto, una sesión secuestrada de un usuario SIN MFA podía
  // auto-enrolar un factor propio y así pasar el step-up (403 mfa_step_up_required /
  // step_up_required guía al cliente a /v1/auth/step-up/password o /v1/auth/mfa/step-up).
  app.post('/v1/auth/mfa/setup', async (req) => {
    const identity = await authService.authenticateSession(bearerToken(req));
    authService.assertFreshStepUp(identity);
    const setup = await authService.setupMfa(identity.userId);
    return { secret: setup.secret, otpauth_uri: setup.otpauthUri };
  });

  app.post('/v1/auth/mfa/activate', async (req) => {
    const identity = await authService.authenticateSession(bearerToken(req));
    authService.assertFreshStepUp(identity);
    const body = MfaCodeOnlySchema.parse(req.body);
    const result = await authService.activateMfa(identity.userId, body.code, {
      sessionId: identity.sessionId,
      ...meta(req),
    });
    // Los codigos de respaldo se muestran UNA sola vez.
    return { enabled: true, backup_codes: result.backupCodes };
  });

  app.post('/v1/auth/mfa/disable', async (req) => {
    const identity = await authService.authenticateSession(bearerToken(req));
    authService.assertFreshStepUp(identity);
    const body = MfaCodeOnlySchema.parse(req.body);
    await authService.disableMfa(identity.userId, body.code, meta(req));
    return { enabled: false };
  });

  // Step-up: refresca la verificacion MFA de ESTA sesion para acciones sensibles.
  app.post(
    '/v1/auth/mfa/step-up',
    { preHandler: rateLimit(limiter, [{ keyOf: ipKey('mfa:ip'), rule: limits.mfaPerIp }]) },
    async (req) => {
      const identity = await authService.authenticateSession(bearerToken(req));
      const body = MfaCodeOnlySchema.parse(req.body);
      const result = await authService.stepUp(
        identity.userId,
        identity.sessionId,
        body.code,
        meta(req)
      );
      return { mfa_verified_at: result.mfaVerifiedAt.toISOString() };
    }
  );

  // TM-02: step-up por RE-AUTENTICACION DE PASSWORD, solo usuarios SIN MFA
  // (con MFA, el password no sustituye al factor fuerte: 403 step-up). Un
  // fallo cuenta contra el MISMO lockout que el login; mismo limite por IP
  // que el resto del plano MFA.
  app.post(
    '/v1/auth/step-up/password',
    { preHandler: rateLimit(limiter, [{ keyOf: ipKey('stepup:ip'), rule: limits.mfaPerIp }]) },
    async (req) => {
      const identity = await authService.authenticateSession(bearerToken(req));
      const body = StepUpPasswordSchema.parse(req.body);
      const result = await authService.stepUpWithPassword(
        identity.userId,
        identity.sessionId,
        body.password,
        meta(req)
      );
      return { password_verified_at: result.passwordVerifiedAt.toISOString() };
    }
  );

  app.post('/v1/auth/logout', async (req, reply) => {
    await authService.logout(bearerToken(req), meta(req));
    return reply.code(204).send();
  });

  // F6 (threat model §5): "cerrar sesión en todos los dispositivos". Revoca
  // TODAS las sesiones del usuario (incluida la actual), auditado. Es el
  // control de gestión de sesiones que faltaba y el hook para una futura
  // revocación automática al cambiar credencial. Requiere sesión válida.
  app.post('/v1/auth/logout-all', async (req, reply) => {
    const identity = await authService.authenticateSession(bearerToken(req));
    const revoked = await authService.revokeAllSessions(identity.userId, meta(req));
    return reply.code(200).send({ revoked_sessions: revoked });
  });

  app.get('/v1/auth/session', async (req) => {
    const identity = await authService.authenticateSession(bearerToken(req));
    const [memberships, mfa] = await Promise.all([
      authService.listMemberships(identity.userId),
      authService.mfaStatus(identity.userId),
    ]);
    return {
      user_id: identity.userId,
      mfa: {
        enabled: mfa.enabled,
        pending_setup: mfa.pendingSetup,
        backup_codes_remaining: mfa.backupCodesRemaining,
        verified_at: identity.mfaVerifiedAt?.toISOString() ?? null,
      },
      memberships: memberships.map((m) => ({
        organization_id: m.organizationId,
        organization_name: m.organizationName,
        organization_slug: m.organizationSlug,
        role: m.role,
      })),
    };
  });
}
