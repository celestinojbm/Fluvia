import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '@fluvia/db/testing';
import {
  AuthService,
  EmailTakenError,
  InvalidVerificationTokenError,
  SandboxRegistrationDisabledError,
} from '../src/index.js';

/**
 * F6.5C1 (B6) — registro sandbox ATOMICO contra PostgreSQL real.
 *
 * Contrato probado: usuario + token + consumo + sello + ambos audits en UNA
 * transaccion; el token en claro jamas sale del metodo; cero sesion; fallo de
 * la verificacion => rollback total; capacidad deshabilitada => fail-closed
 * sin escritura; `register`/`verifyEmail` conservan su contrato (el resto de
 * la suite de auth lo re-verifica sobre el refactor client-bound).
 *
 * Los audits se localizan por `request_id` UNICO por test (columna real de
 * audit_events): determinista y seguro frente a tests paralelos.
 */

let ctx: TestContext;
let sandbox: AuthService;

const uniqueEmail = () => `sbx-${randomUUID().slice(0, 12)}@example.com`;
const PASSWORD = 'sandbox signup password 7';

async function auditActions(requestId: string): Promise<string[]> {
  const res = await ctx.admin.query<{ action: string }>(
    'SELECT action FROM audit_events WHERE request_id = $1 ORDER BY created_at',
    [requestId]
  );
  return res.rows.map((r) => r.action);
}

async function userCount(email: string): Promise<number> {
  const res = await ctx.admin.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM users WHERE lower(email) = $1',
    [email.toLowerCase()]
  );
  return Number(res.rows[0]!.n);
}

beforeAll(async () => {
  ctx = await createTestContext();
  sandbox = new AuthService(ctx.auth, { allowSandboxRegistration: true });
}, 30_000);

afterAll(async () => {
  await ctx.close();
});

describe('registerAndVerifySandbox — exito atomico', () => {
  it('creates ONE verified user with hashed password, both audits, consumed token and ZERO sessions', async () => {
    const email = uniqueEmail();
    const requestId = randomUUID();
    const result = await sandbox.registerAndVerifySandbox(
      { email, password: PASSWORD },
      { requestId }
    );
    expect(result.userId).toBeTruthy();

    // Una sola fila, sellada, con hash scrypt (jamas el password en claro).
    const user = await ctx.admin.query<{
      id: string;
      email_verified_at: Date | null;
      password_hash: string;
    }>('SELECT id, email_verified_at, password_hash FROM users WHERE lower(email) = $1', [email]);
    expect(user.rowCount).toBe(1);
    expect(user.rows[0]!.id).toBe(result.userId);
    expect(user.rows[0]!.email_verified_at).not.toBeNull();
    expect(user.rows[0]!.password_hash).toMatch(/^scrypt\$/);
    expect(user.rows[0]!.password_hash).not.toContain(PASSWORD);

    // Ambos audits, en orden, de la MISMA request.
    expect(await auditActions(requestId)).toEqual(['user.registered', 'user.email_verified']);

    // El token quedo CONSUMIDO dentro de la transaccion.
    const token = await ctx.admin.query<{ consumed_at: Date | null }>(
      'SELECT consumed_at FROM email_verification_tokens WHERE user_id = $1',
      [result.userId]
    );
    expect(token.rowCount).toBe(1);
    expect(token.rows[0]!.consumed_at).not.toBeNull();

    // Cero sesion: el metodo NO auto-loguea.
    const sessions = await ctx.admin.query('SELECT id FROM sessions WHERE user_id = $1', [
      result.userId,
    ]);
    expect(sessions.rowCount).toBe(0);

    // Y el login normal (verificado) funciona como paso SEPARADO.
    const login = await sandbox.login({ email, password: PASSWORD });
    expect(login.mfaRequired).toBe(false);
  });

  it('never exposes the verification token in the result (shape and content)', async () => {
    const result = await sandbox.registerAndVerifySandbox({
      email: uniqueEmail(),
      password: PASSWORD,
    });
    expect(Object.keys(result)).toEqual(['userId']);
    expect(JSON.stringify(result)).not.toContain('fluvia_verify');
  });
});

describe('registerAndVerifySandbox — email duplicado', () => {
  it('throws the existing EmailTakenError and adds NO extra audit rows', async () => {
    const email = uniqueEmail();
    const first = await sandbox.registerAndVerifySandbox({ email, password: PASSWORD });
    const dupRequestId = randomUUID();
    await expect(
      sandbox.registerAndVerifySandbox({ email, password: PASSWORD }, { requestId: dupRequestId })
    ).rejects.toThrow(EmailTakenError);
    expect(await userCount(email)).toBe(1);
    // El intento duplicado no dejo NINGUN audit (fallo antes y rollback).
    expect(await auditActions(dupRequestId)).toEqual([]);
    // Los audits del primer alta siguen siendo exactamente los suyos.
    const firstAudits = await ctx.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_events WHERE actor_id = $1`,
      [first.userId]
    );
    expect(Number(firstAudits.rows[0]!.n)).toBe(2);
  });
});

describe('registerAndVerifySandbox — fallo del paso de verificacion', () => {
  it('rolls back user, token and audits when the consume step fails (expired-at-birth token)', async () => {
    // Fallo inyectable ACOTADO reutilizando una opcion existente: con TTL
    // negativo el token nace expirado y el consumo (mismo WHERE que
    // verifyEmail) no encuentra fila => InvalidVerificationTokenError DENTRO
    // de la transaccion => rollback completo.
    const failing = new AuthService(ctx.auth, {
      allowSandboxRegistration: true,
      verificationTtlMs: -1000,
    });
    const email = uniqueEmail();
    const requestId = randomUUID();
    await expect(
      failing.registerAndVerifySandbox({ email, password: PASSWORD }, { requestId })
    ).rejects.toThrow(InvalidVerificationTokenError);
    // Ni usuario, ni token (FK al usuario), ni auditoria.
    expect(await userCount(email)).toBe(0);
    expect(await auditActions(requestId)).toEqual([]);
  });
});

describe('registerAndVerifySandbox — capacidad deshabilitada (fail-closed)', () => {
  it('default is DISABLED: rejects before touching the database', async () => {
    const disabled = new AuthService(ctx.auth); // sin opcion => default false
    const email = uniqueEmail();
    await expect(disabled.registerAndVerifySandbox({ email, password: PASSWORD })).rejects.toThrow(
      SandboxRegistrationDisabledError
    );
    expect(await userCount(email)).toBe(0);
  });

  it('explicit false also rejects (never silently degrades to register)', async () => {
    const disabled = new AuthService(ctx.auth, { allowSandboxRegistration: false });
    const email = uniqueEmail();
    await expect(disabled.registerAndVerifySandbox({ email, password: PASSWORD })).rejects.toThrow(
      SandboxRegistrationDisabledError
    );
    expect(await userCount(email)).toBe(0);
  });
});

describe('contrato intacto de register/verifyEmail sobre el refactor', () => {
  it('register still returns the plaintext token and verifyEmail still seals in a separate tx', async () => {
    const email = uniqueEmail();
    const reg = await sandbox.register({ email, password: PASSWORD });
    expect(reg.verificationToken).toMatch(/^fluvia_verify_/);
    const before = await ctx.admin.query<{ email_verified_at: Date | null }>(
      'SELECT email_verified_at FROM users WHERE id = $1',
      [reg.userId]
    );
    expect(before.rows[0]!.email_verified_at).toBeNull();
    await sandbox.verifyEmail({ token: reg.verificationToken });
    const after = await ctx.admin.query<{ email_verified_at: Date | null }>(
      'SELECT email_verified_at FROM users WHERE id = $1',
      [reg.userId]
    );
    expect(after.rows[0]!.email_verified_at).not.toBeNull();
  });
});
