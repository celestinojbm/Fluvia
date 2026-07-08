import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '@fluvia/db/testing';
import {
  AccountLockedError,
  AuthService,
  InvalidMfaChallengeError,
  InvalidMfaCodeError,
  MfaAlreadyEnabledError,
  MfaNotEnabledError,
  totpCode,
} from '../src/index.js';

/**
 * F1-04b — ciclo MFA completo contra PG real (AUD-P1-006, PEND-005: TOTP +
 * codigos de respaldo). Los codigos se calculan con el MISMO secreto que el
 * servicio entrega en setup: se prueba el protocolo real, sin mocks.
 */

let ctx: TestContext;
let auth: AuthService;

const PASSWORD = 'correct horse battery st4ple';
const uniqueEmail = () => `mfa-${randomUUID().slice(0, 12)}@test.fluvia.dev`;

interface EnrolledUser {
  email: string;
  userId: string;
  sessionToken: string;
  secret: string;
  backupCodes: string[];
}

async function registeredAndVerified(svc: AuthService = auth) {
  const email = uniqueEmail();
  const reg = await svc.register({ email, password: PASSWORD });
  await svc.verifyEmail({ token: reg.verificationToken });
  const outcome = await svc.login({ email, password: PASSWORD });
  if (outcome.mfaRequired) throw new Error('MFA inesperado antes de enrolar');
  return { email, userId: reg.userId, sessionToken: outcome.sessionToken };
}

/** Enrola MFA de punta a punta (setup -> activate con codigo real). */
async function enrollMfa(svc: AuthService = auth): Promise<EnrolledUser> {
  const base = await registeredAndVerified(svc);
  const identity = await svc.authenticateSession(base.sessionToken);
  const setup = await svc.setupMfa(base.userId);
  const { backupCodes } = await svc.activateMfa(base.userId, totpCode(setup.secret, Date.now()), {
    sessionId: identity.sessionId,
  });
  return { ...base, secret: setup.secret, backupCodes };
}

/**
 * Codigo del step SIGUIENTE (+30 s): dentro de la ventana +/-1 del servicio y
 * estrictamente mayor que el step quemado por la activacion (anti-replay).
 * Nota: tras usarlo, no queda otro step utilizable sin esperar 30 s — los
 * tests estan disenados para necesitar a lo sumo UNO por usuario enrolado.
 */
function freshCode(secret: string): { code: string } {
  return { code: totpCode(secret, Date.now() + 30_000) };
}

beforeAll(async () => {
  ctx = await createTestContext();
  auth = new AuthService(ctx.auth);
}, 30_000);

afterAll(async () => {
  await ctx.close();
});

describe('enrolamiento', () => {
  it('setup -> activate enables MFA, returns 10 backup codes ONCE and stores no plaintext', async () => {
    const user = await enrollMfa();
    expect(user.backupCodes).toHaveLength(10);
    expect(new Set(user.backupCodes).size).toBe(10);
    for (const code of user.backupCodes) expect(code).toMatch(/^[0-9a-f]{5}-[0-9a-f]{5}$/);

    const status = await auth.mfaStatus(user.userId);
    expect(status).toEqual({ enabled: true, pendingSetup: false, backupCodesRemaining: 10 });

    // Nada en claro en la base: ni el secreto base32 ni los backup codes.
    const row = await ctx.admin.query<{ totp_secret_enc: string }>(
      `SELECT totp_secret_enc FROM users WHERE id = $1`,
      [user.userId]
    );
    expect(row.rows[0]!.totp_secret_enc).not.toContain(user.secret);
    const codes = await ctx.admin.query<{ code_hash: string }>(
      `SELECT code_hash FROM mfa_backup_codes WHERE user_id = $1`,
      [user.userId]
    );
    for (const stored of codes.rows) {
      expect(user.backupCodes).not.toContain(stored.code_hash);
      expect(stored.code_hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('activate requires a valid code; setup twice is rejected once enabled', async () => {
    const base = await registeredAndVerified();
    await auth.setupMfa(base.userId);
    await expect(auth.activateMfa(base.userId, '000000')).rejects.toThrow(InvalidMfaCodeError);

    const user = await enrollMfa();
    await expect(auth.setupMfa(user.userId)).rejects.toThrow(MfaAlreadyEnabledError);
    await expect(auth.activateMfa(user.userId, '123456')).rejects.toThrow(MfaAlreadyEnabledError);
  });

  it('activate without prior setup is rejected', async () => {
    const base = await registeredAndVerified();
    await expect(auth.activateMfa(base.userId, '123456')).rejects.toThrow(MfaNotEnabledError);
  });
});

describe('login con MFA (reto -> verificacion -> sesion)', () => {
  it('password alone no longer yields a session; TOTP completes it with mfa_verified_at set', async () => {
    const user = await enrollMfa();
    const outcome = await auth.login({ email: user.email, password: PASSWORD });
    expect(outcome.mfaRequired).toBe(true);
    if (!outcome.mfaRequired) throw new Error('unreachable');
    expect(outcome.challengeToken).toMatch(/^fluvia_mfa_/);

    const { code } = freshCode(user.secret);
    const session = await auth.verifyMfaChallenge({
      challenge_token: outcome.challengeToken,
      code,
    });
    const identity = await auth.authenticateSession(session.sessionToken);
    expect(identity.mfaEnabled).toBe(true);
    expect(identity.mfaVerifiedAt).not.toBeNull();
  });

  it('ANTI-REPLAY: the same TOTP code can never be used twice', async () => {
    const user = await enrollMfa();
    const first = await auth.login({ email: user.email, password: PASSWORD });
    if (!first.mfaRequired) throw new Error('unreachable');
    const { code } = freshCode(user.secret);
    await auth.verifyMfaChallenge({ challenge_token: first.challengeToken, code });

    const second = await auth.login({ email: user.email, password: PASSWORD });
    if (!second.mfaRequired) throw new Error('unreachable');
    await expect(
      auth.verifyMfaChallenge({ challenge_token: second.challengeToken, code })
    ).rejects.toThrow(InvalidMfaCodeError);
  });

  it('challenge is single-success, expires, and garbage tokens are rejected', async () => {
    const user = await enrollMfa();
    const outcome = await auth.login({ email: user.email, password: PASSWORD });
    if (!outcome.mfaRequired) throw new Error('unreachable');
    const { code } = freshCode(user.secret);
    await auth.verifyMfaChallenge({ challenge_token: outcome.challengeToken, code });
    // Reto ya consumido (el reto se valida ANTES que el codigo):
    await expect(
      auth.verifyMfaChallenge({ challenge_token: outcome.challengeToken, code })
    ).rejects.toThrow(InvalidMfaChallengeError);
    await expect(
      auth.verifyMfaChallenge({ challenge_token: 'fluvia_mfa_garbage_token', code: '123456' })
    ).rejects.toThrow(InvalidMfaChallengeError);

    // Reto expirado (TTL negativo).
    const fast = new AuthService(ctx.auth, { mfaChallengeTtlMs: -1000 });
    const expired = await fast.login({ email: user.email, password: PASSWORD });
    if (!expired.mfaRequired) throw new Error('unreachable');
    await expect(
      fast.verifyMfaChallenge({ challenge_token: expired.challengeToken, code: '123456' })
    ).rejects.toThrow(InvalidMfaChallengeError);
  });

  it('a backup code works EXACTLY once and decrements the remaining count', async () => {
    const user = await enrollMfa();
    const backup = user.backupCodes[0]!;
    const first = await auth.login({ email: user.email, password: PASSWORD });
    if (!first.mfaRequired) throw new Error('unreachable');
    const session = await auth.verifyMfaChallenge({
      challenge_token: first.challengeToken,
      code: backup,
    });
    expect(session.sessionToken).toMatch(/^fluvia_sess_/);
    expect((await auth.mfaStatus(user.userId)).backupCodesRemaining).toBe(9);

    const second = await auth.login({ email: user.email, password: PASSWORD });
    if (!second.mfaRequired) throw new Error('unreachable');
    await expect(
      auth.verifyMfaChallenge({ challenge_token: second.challengeToken, code: backup })
    ).rejects.toThrow(InvalidMfaCodeError);
  });

  it('wrong MFA codes feed the SAME lockout as passwords', async () => {
    const service = new AuthService(ctx.auth, { maxFailedAttempts: 3, lockoutMs: 60_000 });
    const user = await enrollMfa(service);
    const outcome = await service.login({ email: user.email, password: PASSWORD });
    if (!outcome.mfaRequired) throw new Error('unreachable');

    await expect(
      service.verifyMfaChallenge({ challenge_token: outcome.challengeToken, code: '000000' })
    ).rejects.toThrow(InvalidMfaCodeError);
    await expect(
      service.verifyMfaChallenge({ challenge_token: outcome.challengeToken, code: '111111' })
    ).rejects.toThrow(InvalidMfaCodeError);
    await expect(
      service.verifyMfaChallenge({ challenge_token: outcome.challengeToken, code: '222222' })
    ).rejects.toThrow(AccountLockedError);
    // Con la cuenta bloqueada, ni el password correcto entra.
    await expect(service.login({ email: user.email, password: PASSWORD })).rejects.toThrow(
      AccountLockedError
    );
  });

  it('SECURITY (F6): re-login with the password does NOT reset the MFA lockout counter', async () => {
    // Un atacante con el password (pero sin el TOTP) intentaba re-loguear entre
    // códigos MFA equivocados para limpiar el contador compartido y adivinar el
    // segundo factor sin límite. Ahora el contador solo se limpia al COMPLETAR el
    // login (verifyMfaChallenge), así que las re-autenticaciones de primer factor
    // no lo resetean y el lockout dispara igual.
    const service = new AuthService(ctx.auth, { maxFailedAttempts: 3, lockoutMs: 60_000 });
    const user = await enrollMfa(service);

    const freshChallenge = async (): Promise<string> => {
      const outcome = await service.login({ email: user.email, password: PASSWORD });
      if (!outcome.mfaRequired) throw new Error('unreachable');
      return outcome.challengeToken;
    };

    // Cada intento MFA equivocado va precedido de un re-login (primer factor OK).
    const c1 = await freshChallenge();
    await expect(
      service.verifyMfaChallenge({ challenge_token: c1, code: '000000' })
    ).rejects.toThrow(InvalidMfaCodeError); // intento 1
    const c2 = await freshChallenge(); // el re-login NO debe resetear el contador
    await expect(
      service.verifyMfaChallenge({ challenge_token: c2, code: '111111' })
    ).rejects.toThrow(InvalidMfaCodeError); // intento 2
    const c3 = await freshChallenge();
    // 3.er MFA equivocado alcanza maxFailedAttempts=3 y BLOQUEA, pese a los re-logins.
    await expect(
      service.verifyMfaChallenge({ challenge_token: c3, code: '222222' })
    ).rejects.toThrow(AccountLockedError);
  });
});

describe('step-up y disable', () => {
  it('stepUp refreshes mfa_verified_at with a fresh code (replay rejected)', async () => {
    const user = await enrollMfa();
    const identity = await auth.authenticateSession(user.sessionToken);
    const { code } = freshCode(user.secret);
    const result = await auth.stepUp(user.userId, identity.sessionId, code);
    expect(result.mfaVerifiedAt.getTime()).toBeGreaterThan(Date.now() - 5_000);
    // El mismo codigo no vale dos veces (anti-replay tambien en step-up).
    await expect(auth.stepUp(user.userId, identity.sessionId, code)).rejects.toThrow(
      InvalidMfaCodeError
    );
  });

  it('disable requires a valid TOTP (backup code NOT accepted) and invalidates backups', async () => {
    const user = await enrollMfa();
    await expect(auth.disableMfa(user.userId, user.backupCodes[1]!)).rejects.toThrow(
      InvalidMfaCodeError
    );
    await auth.disableMfa(user.userId, freshCode(user.secret).code);
    const status = await auth.mfaStatus(user.userId);
    expect(status).toEqual({ enabled: false, pendingSetup: false, backupCodesRemaining: 0 });
    // Login vuelve a ser directo (sin reto).
    const outcome = await auth.login({ email: user.email, password: PASSWORD });
    expect(outcome.mfaRequired).toBe(false);
  });
});
