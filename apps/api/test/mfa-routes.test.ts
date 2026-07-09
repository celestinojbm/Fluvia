import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@fluvia/config';
import { createTestContext, type TestContext } from '@fluvia/db/testing';
import { AuthService, totpCode } from '@fluvia/auth';
import { ApiKeyService, IdentityService } from '@fluvia/identity';
import { buildApp } from '../src/app.js';

/**
 * F1-04b sobre HTTP real: enrolamiento, login con reto, step-up para
 * keys:manage y rate limiting con el sobre del catalogo v1.
 */

let ctx: TestContext;
let app: FastifyInstance;
let authService: AuthService;

const PASSWORD = 'correct horse battery st4ple';
const uniqueEmail = () => `mfahttp-${randomUUID().slice(0, 10)}@test.fluvia.dev`;

async function registerAndLogin(email = uniqueEmail()) {
  const reg = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email, password: PASSWORD },
  });
  const { user_id, verification_token } = reg.json() as {
    user_id: string;
    verification_token: string;
  };
  await app.inject({
    method: 'POST',
    url: '/v1/auth/verify-email',
    payload: { token: verification_token },
  });
  const login = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email, password: PASSWORD },
  });
  return {
    email,
    userId: user_id,
    sessionToken: (login.json() as { session_token: string }).session_token,
  };
}

function authed(token: string) {
  return { authorization: `Bearer ${token}` };
}

/** Org nueva con el usuario como owner (patron del suite org-routes). */
async function ownedOrg(userId: string): Promise<string> {
  const org = await ctx.admin.query<{ id: string }>(
    `INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id`,
    [`MfaOrg-${randomUUID().slice(0, 6)}`, `mfa-org-${randomUUID().slice(0, 10)}`]
  );
  await ctx.admin.query(
    `INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [org.rows[0]!.id, userId]
  );
  return org.rows[0]!.id;
}

/** Enrola MFA via HTTP y devuelve el secreto + backup codes + sesion. */
async function enrollViaHttp() {
  const user = await registerAndLogin();
  // F6 (revisión de seguridad, TM-02): enrolar MFA exige step-up fresco. Un
  // usuario SIN MFA re-autentica con su password antes de setup/activate.
  const stepUp = await app.inject({
    method: 'POST',
    url: '/v1/auth/step-up/password',
    headers: authed(user.sessionToken),
    payload: { password: PASSWORD },
  });
  expect(stepUp.statusCode).toBe(200);
  const setup = await app.inject({
    method: 'POST',
    url: '/v1/auth/mfa/setup',
    headers: authed(user.sessionToken),
  });
  const { secret, otpauth_uri } = setup.json() as { secret: string; otpauth_uri: string };
  expect(otpauth_uri).toContain('otpauth://totp/');
  const activate = await app.inject({
    method: 'POST',
    url: '/v1/auth/mfa/activate',
    headers: authed(user.sessionToken),
    payload: { code: totpCode(secret, Date.now()) },
  });
  expect(activate.statusCode).toBe(200);
  const { backup_codes } = activate.json() as { backup_codes: string[] };
  return { ...user, secret, backupCodes: backup_codes };
}

beforeAll(async () => {
  ctx = await createTestContext();
  authService = new AuthService(ctx.auth);
  app = buildApp({
    config: loadConfig({}),
    appPool: ctx.app,
    authService,
    identityService: new IdentityService(ctx.app),
    apiKeyService: new ApiKeyService(ctx.app),
    // La app principal de la suite usa limites generosos; los limites reales
    // se prueban abajo con apps estrictas dedicadas.
    authRateLimits: {
      loginPerEmail: { max: 10_000, windowMs: 60_000 },
      loginPerIp: { max: 10_000, windowMs: 60_000 },
      registerPerIp: { max: 10_000, windowMs: 60_000 },
      mfaPerIp: { max: 10_000, windowMs: 60_000 },
    },
  });
  await app.ready();
}, 30_000);

afterAll(async () => {
  await app.close();
  await ctx.close();
});

describe('MFA sobre HTTP', () => {
  it('full cycle: enroll -> login yields challenge -> verify yields session', async () => {
    const user = await enrollViaHttp();
    expect(user.backupCodes).toHaveLength(10);

    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: user.email, password: PASSWORD },
    });
    const body = login.json() as { mfa_required: boolean; challenge_token: string };
    expect(body.mfa_required).toBe(true);
    expect(body).not.toHaveProperty('session_token'); // password solo NO da sesion

    const bad = await app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/verify',
      payload: { challenge_token: body.challenge_token, code: '000000' },
    });
    expect(bad.statusCode).toBe(401);
    expect((bad.json() as { error: { code: string } }).error.code).toBe('invalid_mfa_code');

    const ok = await app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/verify',
      payload: {
        challenge_token: body.challenge_token,
        code: totpCode(user.secret, Date.now() + 30_000),
      },
    });
    expect(ok.statusCode).toBe(200);
    const { session_token } = ok.json() as { session_token: string };

    const session = await app.inject({
      method: 'GET',
      url: '/v1/auth/session',
      headers: authed(session_token),
    });
    const s = session.json() as {
      mfa: { enabled: boolean; verified_at: string | null; backup_codes_remaining: number };
    };
    expect(s.mfa.enabled).toBe(true);
    expect(s.mfa.verified_at).not.toBeNull();
    expect(s.mfa.backup_codes_remaining).toBe(10);
  });

  it('STEP-UP: with MFA enabled, keys:manage requires fresh verification', async () => {
    const user = await enrollViaHttp();
    // Sesion nueva SIN verificacion MFA fresca: la de activacion quedo
    // verificada, asi que se usa una sesion emitida via challenge y luego
    // se fuerza el envejecimiento de mfa_verified_at.
    const orgId = await ownedOrg(user.userId);

    // Envejecer la verificacion de la sesion actual (mas alla del maxAge).
    await ctx.admin.query(
      `UPDATE sessions SET mfa_verified_at = now() - interval '1 hour'
       WHERE user_id = $1`,
      [user.userId]
    );

    const denied = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/api-keys`,
      headers: authed(user.sessionToken),
      payload: { label: 'needs-stepup', scopes: ['read'] },
    });
    expect(denied.statusCode).toBe(403);
    const deniedBody = denied.json() as { error: { code: string; type: string } };
    expect(deniedBody.error.code).toBe('mfa_step_up_required');
    expect(deniedBody.error.type).toBe('authorization_error');

    const stepUp = await app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/step-up',
      headers: authed(user.sessionToken),
      payload: { code: totpCode(user.secret, Date.now() + 30_000) },
    });
    expect(stepUp.statusCode).toBe(200);

    const allowed = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/api-keys`,
      headers: authed(user.sessionToken),
      payload: { label: 'after-stepup', scopes: ['read'] },
    });
    expect(allowed.statusCode).toBe(201);
  });

  it('TM-02: users WITHOUT MFA must re-authenticate with their password (step-up is no longer a no-op)', async () => {
    const user = await registerAndLogin();
    const orgId = await ownedOrg(user.userId);
    const createKey = () =>
      app.inject({
        method: 'POST',
        url: `/v1/organizations/${orgId}/api-keys`,
        headers: authed(user.sessionToken),
        payload: { label: 'no-mfa-user', scopes: ['read'] },
      });

    // Sin re-autenticacion fresca: BLOQUEADO (antes esto pasaba — el hueco TM-02).
    const blocked = await createKey();
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('mfa_step_up_required');

    // Password equivocado: 401 uniforme, y NO desbloquea.
    const wrong = await app.inject({
      method: 'POST',
      url: '/v1/auth/step-up/password',
      headers: authed(user.sessionToken),
      payload: { password: 'not-the-password-123' },
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error.code).toBe('invalid_credentials');
    expect((await createKey()).statusCode).toBe(403);

    // Re-autenticacion correcta: refresca password_verified_at y desbloquea.
    const ok = await app.inject({
      method: 'POST',
      url: '/v1/auth/step-up/password',
      headers: authed(user.sessionToken),
      payload: { password: PASSWORD },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().password_verified_at).toBeTruthy();
    expect((await createKey()).statusCode).toBe(201);
  });

  it('TM-02: with MFA enabled, the password path does NOT substitute the strong factor', async () => {
    const user = await enrollViaHttp(); // usuario CON MFA
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/step-up/password',
      headers: authed(user.sessionToken),
      payload: { password: PASSWORD },
    });
    // El servicio exige TOTP: el password jamas refresca el step-up de un usuario MFA.
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('mfa_step_up_required');
  });

  it('SECURITY (F6): a hijacked no-MFA session cannot self-enroll MFA to defeat the step-up gate', async () => {
    // Sesión SIN MFA y SIN step-up fresco (lo que tiene un atacante con un token robado).
    const user = await registerAndLogin();
    const orgId = await ownedOrg(user.userId);

    // El camino del atacante: auto-enrolar un factor MFA propio para pasar el
    // step-up. Ahora BLOQUEADO — setup/activate exigen re-autenticación fresca.
    const setup = await app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/setup',
      headers: authed(user.sessionToken),
    });
    expect(setup.statusCode).toBe(403);
    expect(setup.json().error.code).toBe('mfa_step_up_required');

    const activate = await app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/activate',
      headers: authed(user.sessionToken),
      payload: { code: '123456' },
    });
    expect(activate.statusCode).toBe(403);
    expect(activate.json().error.code).toBe('mfa_step_up_required');

    // Y acuñar API keys sigue bloqueado: el step-up no fue satisfecho.
    const key = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/api-keys`,
      headers: authed(user.sessionToken),
      payload: { label: 'attacker', scopes: ['read'] },
    });
    expect(key.statusCode).toBe(403);
    expect(key.json().error.code).toBe('mfa_step_up_required');

    // El camino legítimo: re-autenticar con el PASSWORD (que el atacante no tiene),
    // y entonces sí enrolar MFA.
    const stepUp = await app.inject({
      method: 'POST',
      url: '/v1/auth/step-up/password',
      headers: authed(user.sessionToken),
      payload: { password: PASSWORD },
    });
    expect(stepUp.statusCode).toBe(200);
    const setupOk = await app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/setup',
      headers: authed(user.sessionToken),
    });
    expect(setupOk.statusCode).toBe(200);
  });
});

describe('rate limiting (AUD-P1-006) con el catalogo v1', () => {
  it('throttles login per-EMAIL with 429 rate_limited + Retry-After', async () => {
    const strict = buildApp({
      config: loadConfig({}),
      appPool: ctx.app,
      authService,
      authRateLimits: {
        loginPerEmail: { max: 2, windowMs: 60_000 },
        loginPerIp: { max: 100, windowMs: 60_000 },
        registerPerIp: { max: 100, windowMs: 60_000 },
        mfaPerIp: { max: 100, windowMs: 60_000 },
      },
    });
    await strict.ready();
    const email = uniqueEmail();
    const attempt = () =>
      strict.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email, password: 'whatever wrong pass' },
      });
    expect((await attempt()).statusCode).toBe(401);
    expect((await attempt()).statusCode).toBe(401);
    const limited = await attempt();
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    const body = limited.json() as { error: { code: string; type: string } };
    expect(body.error).toMatchObject({ code: 'rate_limited', type: 'rate_limit_error' });
    // Otro email desde la misma IP sigue permitido (limite por cuenta objetivo).
    const other = await strict.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: uniqueEmail(), password: 'whatever wrong pass' },
    });
    expect(other.statusCode).toBe(401);
    await strict.close();
  });

  it('throttles register per-IP', async () => {
    const strict = buildApp({
      config: loadConfig({}),
      appPool: ctx.app,
      authService,
      authRateLimits: {
        loginPerEmail: { max: 100, windowMs: 60_000 },
        loginPerIp: { max: 100, windowMs: 60_000 },
        registerPerIp: { max: 1, windowMs: 60_000 },
        mfaPerIp: { max: 100, windowMs: 60_000 },
      },
    });
    await strict.ready();
    const first = await strict.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: uniqueEmail(), password: PASSWORD },
    });
    expect(first.statusCode).toBe(201);
    const limited = await strict.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: uniqueEmail(), password: PASSWORD },
    });
    expect(limited.statusCode).toBe(429);
    await strict.close();
  });
});
