import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '@fluvia/db/testing';
import {
  AuthService,
  DEV_MFA_SECRET_KEY_HEX,
  decryptMfaSecretWithKeyring,
  encryptMfaSecret,
  generateTotpSecret,
  inspectMfaSecretKeys,
  reencryptMfaSecrets,
  totpCode,
  type MfaEncKeyring,
} from '../src/index.js';

/**
 * F6 (ADR-0012) — rotación de la clave de cifrado de secretos TOTP
 * (`MFA_SECRET_KEY`) contra PG real. La clave nueva (ACTUAL) es la de config
 * (DEV), la vieja (`OLD_KEY`) queda RETIRADA; el barrido `reencryptMfaSecrets`
 * (rol `fluvia_auth`, mínimo privilegio — `ctx.auth`, como en producción) migra
 * `users.totp_secret_enc`/`totp_pending_secret_enc` a la
 * actual preservando el secreto TOTP en claro. Se re-cifra HACIA la clave de
 * config para dejar la BD consistente para el resto de la suite.
 */

const PASSWORD = 'correct horse battery st4ple';
const OLD_KEY = '1a'.repeat(32);
const UNKNOWN_KEY = '99'.repeat(32);
const CURRENT = DEV_MFA_SECRET_KEY_HEX;
const rotating: MfaEncKeyring = { current: CURRENT, retired: [OLD_KEY] };
const currentOnly: MfaEncKeyring = { current: CURRENT, retired: [] };

let ctx: TestContext;
const uniqueEmail = () => `mfarot-${randomUUID().slice(0, 12)}@test.fluvia.dev`;

/** Inserta directamente un usuario con secreto TOTP (+pending opcional) cifrado.
 *  `pendingKeyHex` permite cifrar el pending con OTRA clave (fila "mixta"). */
async function seedUser(
  keyHex: string,
  secret: string,
  pendingSecret: string | null,
  pendingKeyHex: string = keyHex
): Promise<string> {
  const res = await ctx.admin.query<{ id: string }>(
    `INSERT INTO users (email, totp_secret_enc, totp_pending_secret_enc, totp_enabled_at)
     VALUES ($1, $2, $3, now()) RETURNING id`,
    [
      uniqueEmail(),
      encryptMfaSecret(keyHex, secret),
      pendingSecret === null ? null : encryptMfaSecret(pendingKeyHex, pendingSecret),
    ]
  );
  return res.rows[0]!.id;
}

async function readBlobs(
  id: string
): Promise<{ totp_secret_enc: string | null; totp_pending_secret_enc: string | null }> {
  const r = await ctx.admin.query<{
    totp_secret_enc: string | null;
    totp_pending_secret_enc: string | null;
  }>(`SELECT totp_secret_enc, totp_pending_secret_enc FROM users WHERE id = $1`, [id]);
  return r.rows[0]!;
}

/** Enrola MFA de punta a punta con `svc` (su clave ACTUAL cifra el secreto). */
async function enrollMfa(
  svc: AuthService
): Promise<{ email: string; userId: string; secret: string }> {
  const email = uniqueEmail();
  const reg = await svc.register({ email, password: PASSWORD });
  await svc.verifyEmail({ token: reg.verificationToken });
  const outcome = await svc.login({ email, password: PASSWORD });
  if (outcome.mfaRequired) throw new Error('MFA inesperado antes de enrolar');
  const identity = await svc.authenticateSession(outcome.sessionToken);
  const setup = await svc.setupMfa(reg.userId);
  await svc.activateMfa(reg.userId, totpCode(setup.secret, Date.now()), {
    sessionId: identity.sessionId,
  });
  return { email, userId: reg.userId, secret: setup.secret };
}

/** Login + verificación del reto MFA con un código fresco (step siguiente). */
async function loginAndVerifyMfa(svc: AuthService, email: string, secret: string): Promise<void> {
  const outcome = await svc.login({ email, password: PASSWORD });
  if (!outcome.mfaRequired) throw new Error('se esperaba MFA');
  const session = await svc.verifyMfaChallenge({
    challenge_token: outcome.challengeToken,
    code: totpCode(secret, Date.now() + 30_000),
  });
  expect(session.sessionToken).toMatch(/^fluvia_/);
}

beforeAll(async () => {
  ctx = await createTestContext();
}, 30_000);

afterAll(async () => {
  await ctx.close();
});

describe('rotación de la clave de cifrado de secretos TOTP (keyring + re-cifrado)', () => {
  it('re-cifra de la clave retirada a la actual, preservando el secreto TOTP', async () => {
    const s1 = generateTotpSecret();
    const s1pending = generateTotpSecret();
    const s2 = generateTotpSecret();
    const u1 = await seedUser(OLD_KEY, s1, s1pending);
    const u2 = await seedUser(OLD_KEY, s2, null);

    // ANTES: el keyring de rotación descifra; solo-actual NO (se necesita la vieja).
    const before = await readBlobs(u1);
    expect(decryptMfaSecretWithKeyring(rotating, before.totp_secret_enc!)).toEqual({
      plaintext: s1,
      isCurrent: false,
    });
    expect(() => decryptMfaSecretWithKeyring(currentOnly, before.totp_secret_enc!)).toThrow(
      /no MFA enc key/i
    );

    const res = await reencryptMfaSecrets(ctx.auth, rotating, { userIds: [u1, u2] });
    expect(res.total).toBe(2);
    expect(res.reencrypted).toBe(2);
    expect(res.alreadyCurrent).toBe(0);
    expect(res.failed).toBe(0);

    // DESPUÉS: solo con la ACTUAL se descifra todo, con el claro intacto.
    const a = await readBlobs(u1);
    expect(decryptMfaSecretWithKeyring(currentOnly, a.totp_secret_enc!)).toEqual({
      plaintext: s1,
      isCurrent: true,
    });
    expect(decryptMfaSecretWithKeyring(currentOnly, a.totp_pending_secret_enc!).plaintext).toBe(
      s1pending
    );
    const b = await readBlobs(u2);
    expect(decryptMfaSecretWithKeyring(currentOnly, b.totp_secret_enc!).plaintext).toBe(s2);
    // El pending NULL se preserva como NULL.
    expect(b.totp_pending_secret_enc).toBeNull();
  }, 30_000);

  it('es idempotente: una segunda corrida no re-cifra nada', async () => {
    const u = await seedUser(OLD_KEY, generateTotpSecret(), null);
    const first = await reencryptMfaSecrets(ctx.auth, rotating, { userIds: [u] });
    expect(first.reencrypted).toBe(1);
    const second = await reencryptMfaSecrets(ctx.auth, rotating, { userIds: [u] });
    expect(second.reencrypted).toBe(0);
    expect(second.failed).toBe(0);
    expect(second.alreadyCurrent).toBe(second.total);
  }, 30_000);

  it('el filtro userIds acota el re-cifrado (no toca otros usuarios)', async () => {
    const included = await seedUser(OLD_KEY, generateTotpSecret(), null);
    const isoSecret = generateTotpSecret();
    const isolated = await seedUser(OLD_KEY, isoSecret, null);
    await reencryptMfaSecrets(ctx.auth, rotating, { userIds: [included] });
    // `isolated` sigue bajo la VIEJA (solo-actual no lo descifra; el rotating sí).
    const iso = await readBlobs(isolated);
    expect(() => decryptMfaSecretWithKeyring(currentOnly, iso.totp_secret_enc!)).toThrow();
    expect(decryptMfaSecretWithKeyring(rotating, iso.totp_secret_enc!).isCurrent).toBe(false);
    // Y un barrido que lo incluya lo migra (deja la BD consistente).
    await reencryptMfaSecrets(ctx.auth, rotating, { userIds: [isolated] });
    const after = await readBlobs(isolated);
    expect(decryptMfaSecretWithKeyring(currentOnly, after.totp_secret_enc!).plaintext).toBe(
      isoSecret
    );
  }, 30_000);

  it('fila mixta (secret ACTUAL, pending RETIRADO): re-cifra el pending pendiente', async () => {
    const sCur = generateTotpSecret();
    const sPending = generateTotpSecret();
    const u = await seedUser(CURRENT, sCur, sPending, OLD_KEY);
    const res = await reencryptMfaSecrets(ctx.auth, rotating, { userIds: [u] });
    expect(res.reencrypted).toBe(1);
    expect(res.alreadyCurrent).toBe(0);
    const a = await readBlobs(u);
    expect(decryptMfaSecretWithKeyring(currentOnly, a.totp_secret_enc!).plaintext).toBe(sCur);
    expect(decryptMfaSecretWithKeyring(currentOnly, a.totp_pending_secret_enc!).plaintext).toBe(
      sPending
    );
  }, 30_000);

  it('resiliencia: un usuario indescifrable se REPORTA (failed) sin abortar los demás', async () => {
    const good = generateTotpSecret();
    const uGood = await seedUser(OLD_KEY, good, null);
    const uPoison = await seedUser(UNKNOWN_KEY, generateTotpSecret(), null);

    const res = await reencryptMfaSecrets(ctx.auth, rotating, { userIds: [uGood, uPoison] });
    expect(res.total).toBe(2);
    expect(res.reencrypted).toBe(1);
    expect(res.failed).toBe(1);
    expect(res.failedIds).toContain(uPoison);

    // El bueno migró; el envenenado quedó INTACTO (bajo su clave desconocida).
    expect(
      decryptMfaSecretWithKeyring(currentOnly, (await readBlobs(uGood)).totp_secret_enc!).plaintext
    ).toBe(good);
    expect(
      decryptMfaSecretWithKeyring(
        { current: UNKNOWN_KEY, retired: [] },
        (await readBlobs(uPoison)).totp_secret_enc!
      ).plaintext
    ).toBeTypeOf('string');
  }, 30_000);

  it('inspección de solo-lectura: cuenta bajo-retirada/actual/indescifrable sin mutar', async () => {
    const uA = await seedUser(OLD_KEY, generateTotpSecret(), null);
    const uB = await seedUser(OLD_KEY, generateTotpSecret(), null);
    const uPoison = await seedUser(UNKNOWN_KEY, generateTotpSecret(), null);
    const ids = [uA, uB, uPoison];

    const before = await inspectMfaSecretKeys(ctx.auth, rotating, { userIds: ids });
    expect(before.total).toBe(3);
    expect(before.underRetired).toBe(2);
    expect(before.underCurrent).toBe(0);
    expect(before.undecryptable).toBe(1);
    expect(before.undecryptableIds).toContain(uPoison);

    // No muta: un segundo vistazo da lo mismo.
    const again = await inspectMfaSecretKeys(ctx.auth, rotating, { userIds: ids });
    expect(again.underRetired).toBe(2);

    // Tras el barrido: nada bajo la retirada; el indescifrable sigue reportado.
    await reencryptMfaSecrets(ctx.auth, rotating, { userIds: ids });
    const after = await inspectMfaSecretKeys(ctx.auth, rotating, { userIds: ids });
    expect(after.underRetired).toBe(0);
    expect(after.underCurrent).toBe(2);
    expect(after.undecryptable).toBe(1);
  }, 30_000);

  it('end-to-end: un usuario bajo la clave RETIRADA autentica por el servicio (ventana de rotación)', async () => {
    // Enrolado con la clave VIEJA (svcOld cifra con OLD_KEY).
    const svcOld = new AuthService(ctx.auth, { mfaEncryptionKeyHex: OLD_KEY });
    const user = await enrollMfa(svcOld);
    // El servicio en rotación (actual=CURRENT, retirada=[OLD]) lo verifica SIN migrar.
    const svcRotating = new AuthService(ctx.auth, {
      mfaEncryptionKeyHex: CURRENT,
      retiredMfaKeyHexes: [OLD_KEY],
    });
    await loginAndVerifyMfa(svcRotating, user.email, user.secret);
    // Deja la BD consistente: migra su secreto a la clave actual.
    const res = await reencryptMfaSecrets(ctx.auth, rotating, { userIds: [user.userId] });
    expect(res.reencrypted).toBe(1);
  }, 30_000);

  it('end-to-end: tras el barrido, el usuario autentica con SOLO la clave actual', async () => {
    const svcOld = new AuthService(ctx.auth, { mfaEncryptionKeyHex: OLD_KEY });
    const user = await enrollMfa(svcOld);
    // Migra OLD → CURRENT, luego un servicio con SOLO la actual (retirada eliminada) verifica.
    const res = await reencryptMfaSecrets(ctx.auth, rotating, { userIds: [user.userId] });
    expect(res.reencrypted).toBe(1);
    const svcCurrent = new AuthService(ctx.auth, { mfaEncryptionKeyHex: CURRENT });
    await loginAndVerifyMfa(svcCurrent, user.email, user.secret);
  }, 30_000);
});
