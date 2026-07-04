import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '@fluvia/db/testing';
import {
  AccountLockedError,
  AuthService,
  EmailNotVerifiedError,
  EmailTakenError,
  InvalidCredentialsError,
  InvalidSessionError,
  InvalidVerificationTokenError,
} from '../src/index.js';

let ctx: TestContext;
let auth: AuthService;

const uniqueEmail = () => `user-${randomUUID().slice(0, 12)}@example.com`;
const PASSWORD = 'a very strong password 42';

async function registeredAndVerified(service = auth) {
  const email = uniqueEmail();
  const reg = await service.register({ email, password: PASSWORD });
  await service.verifyEmail({ token: reg.verificationToken });
  return { email, userId: reg.userId };
}

beforeAll(async () => {
  ctx = await createTestContext();
  auth = new AuthService(ctx.auth);
}, 30_000);

afterAll(async () => {
  await ctx.close();
});

describe('register + verify + login (camino feliz)', () => {
  it('registers, verifies email and logs in', async () => {
    const email = uniqueEmail();
    const reg = await auth.register({ email, password: PASSWORD });
    expect(reg.userId).toBeTruthy();
    expect(reg.verificationToken).toMatch(/^fluvia_verify_/);

    // Sin verificar: login bloqueado con error especifico (password ya validado).
    await expect(auth.login({ email, password: PASSWORD })).rejects.toThrow(EmailNotVerifiedError);

    await auth.verifyEmail({ token: reg.verificationToken });
    const login = await auth.login({ email, password: PASSWORD });
    expect(login.sessionToken).toMatch(/^fluvia_sess_/);
    expect(login.userId).toBe(reg.userId);
    expect(login.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('normalizes email case on register and login', async () => {
    const email = uniqueEmail();
    const reg = await auth.register({ email: email.toUpperCase(), password: PASSWORD });
    await auth.verifyEmail({ token: reg.verificationToken });
    await expect(auth.login({ email, password: PASSWORD })).resolves.toBeTruthy();
  });

  it('rejects duplicate registration', async () => {
    const email = uniqueEmail();
    await auth.register({ email, password: PASSWORD });
    await expect(auth.register({ email, password: PASSWORD })).rejects.toThrow(EmailTakenError);
  });

  it('rejects weak passwords and unknown fields (strict schema)', async () => {
    await expect(auth.register({ email: uniqueEmail(), password: 'short' })).rejects.toThrow();
    await expect(
      auth.register({ email: uniqueEmail(), password: PASSWORD, admin: true } as never)
    ).rejects.toThrow();
  });
});

describe('tokens de verificacion', () => {
  it('is single-use', async () => {
    const reg = await auth.register({ email: uniqueEmail(), password: PASSWORD });
    await auth.verifyEmail({ token: reg.verificationToken });
    await expect(auth.verifyEmail({ token: reg.verificationToken })).rejects.toThrow(
      InvalidVerificationTokenError
    );
  });

  it('rejects unknown and expired tokens', async () => {
    await expect(auth.verifyEmail({ token: 'fluvia_verify_deadbeef00' })).rejects.toThrow(
      InvalidVerificationTokenError
    );
    const shortLived = new AuthService(ctx.auth, { verificationTtlMs: -1000 });
    const reg = await shortLived.register({ email: uniqueEmail(), password: PASSWORD });
    await expect(shortLived.verifyEmail({ token: reg.verificationToken })).rejects.toThrow(
      InvalidVerificationTokenError
    );
  });
});

describe('anti-enumeracion y lockout', () => {
  it('unknown email and wrong password raise the SAME error class', async () => {
    const { email } = await registeredAndVerified();
    await expect(auth.login({ email: uniqueEmail(), password: PASSWORD })).rejects.toThrow(
      InvalidCredentialsError
    );
    await expect(auth.login({ email, password: 'wrong password 12345' })).rejects.toThrow(
      InvalidCredentialsError
    );
  });

  it('locks the account after N failed attempts, even with the right password', async () => {
    const service = new AuthService(ctx.auth, { maxFailedAttempts: 3, lockoutMs: 60_000 });
    const { email } = await registeredAndVerified(service);
    await expect(service.login({ email, password: 'bad password 1x' })).rejects.toThrow(
      InvalidCredentialsError
    );
    await expect(service.login({ email, password: 'bad password 2x' })).rejects.toThrow(
      InvalidCredentialsError
    );
    // Tercer fallo => lock.
    await expect(service.login({ email, password: 'bad password 3x' })).rejects.toThrow(
      AccountLockedError
    );
    // Con password correcto tambien bloqueado mientras dure la ventana.
    await expect(service.login({ email, password: PASSWORD })).rejects.toThrow(AccountLockedError);
  });

  it('allows login again after the lock window expires and resets the counter on success', async () => {
    const service = new AuthService(ctx.auth, { maxFailedAttempts: 2, lockoutMs: 50 });
    const { email } = await registeredAndVerified(service);
    await expect(service.login({ email, password: 'bad password 1x' })).rejects.toThrow();
    await expect(service.login({ email, password: 'bad password 2x' })).rejects.toThrow(
      AccountLockedError
    );
    await new Promise((r) => setTimeout(r, 120));
    const ok = await service.login({ email, password: PASSWORD });
    expect(ok.sessionToken).toBeTruthy();
  });
});

describe('sesiones', () => {
  it('authenticates a live session and rejects garbage tokens', async () => {
    const { email, userId } = await registeredAndVerified();
    const { sessionToken } = await auth.login({ email, password: PASSWORD });
    const identity = await auth.authenticateSession(sessionToken);
    expect(identity.userId).toBe(userId);
    await expect(auth.authenticateSession('fluvia_sess_garbage')).rejects.toThrow(
      InvalidSessionError
    );
  });

  it('rejects expired sessions', async () => {
    const service = new AuthService(ctx.auth, { sessionTtlMs: -1000 });
    const { email } = await registeredAndVerified(service);
    const { sessionToken } = await service.login({ email, password: PASSWORD });
    await expect(service.authenticateSession(sessionToken)).rejects.toThrow(InvalidSessionError);
  });

  it('logout revokes exactly that session', async () => {
    const { email } = await registeredAndVerified();
    const s1 = await auth.login({ email, password: PASSWORD });
    const s2 = await auth.login({ email, password: PASSWORD });
    await auth.logout(s1.sessionToken);
    await expect(auth.authenticateSession(s1.sessionToken)).rejects.toThrow(InvalidSessionError);
    await expect(auth.authenticateSession(s2.sessionToken)).resolves.toBeTruthy();
  });

  it('revokeAllSessions kills every live session for the user', async () => {
    const { email, userId } = await registeredAndVerified();
    const s1 = await auth.login({ email, password: PASSWORD });
    const s2 = await auth.login({ email, password: PASSWORD });
    const revoked = await auth.revokeAllSessions(userId);
    expect(revoked).toBeGreaterThanOrEqual(2);
    await expect(auth.authenticateSession(s1.sessionToken)).rejects.toThrow(InvalidSessionError);
    await expect(auth.authenticateSession(s2.sessionToken)).rejects.toThrow(InvalidSessionError);
  });
});

describe('membresias post-login', () => {
  it('lists organizations the user belongs to via auth_list_memberships', async () => {
    const { userId } = await registeredAndVerified();
    expect(await auth.listMemberships(userId)).toEqual([]);

    const org = await ctx.createTenant('Org Con Miembro');
    await ctx.admin.query(
      "INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'admin')",
      [org, userId]
    );
    const memberships = await auth.listMemberships(userId);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]!.organizationId).toBe(org);
    expect(memberships[0]!.role).toBe('admin');
  });
});

describe('separacion de planos', () => {
  it('the app role has NO access to sessions or verification tokens', async () => {
    await expect(ctx.app.query('SELECT count(*) FROM sessions')).rejects.toThrow(
      /permission denied/i
    );
    await expect(ctx.app.query('SELECT count(*) FROM email_verification_tokens')).rejects.toThrow(
      /permission denied/i
    );
  });

  it('stored session tokens are hashes, never plaintext', async () => {
    const { email } = await registeredAndVerified();
    const { sessionToken } = await auth.login({ email, password: PASSWORD });
    const rows = await ctx.admin.query<{ token_hash: string }>(
      'SELECT token_hash FROM sessions ORDER BY created_at DESC LIMIT 5'
    );
    expect(rows.rows.every((r) => r.token_hash !== sessionToken)).toBe(true);
    expect(rows.rows.every((r) => /^[0-9a-f]{64}$/.test(r.token_hash))).toBe(true);
  });
});
