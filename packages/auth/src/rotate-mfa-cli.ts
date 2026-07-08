import { loadConfig } from '@fluvia/config';
import { createPool } from '@fluvia/db';
import { inspectMfaSecretKeys, reencryptMfaSecrets } from './rotate-mfa.js';

/**
 * CLI de rotación de la clave de cifrado de los secretos TOTP (F6, ADR-0012).
 * Runbook: `docs/ops/runbooks/mfa-key-rotation.md`. Con la clave nueva ya como
 * ACTUAL (`MFA_SECRET_KEY`) y la vieja como RETIRADA (`MFA_SECRET_KEY_RETIRED`):
 *
 *   pnpm --filter @fluvia/auth run rotate:mfa-key            # re-cifra
 *   pnpm --filter @fluvia/auth run rotate:mfa-key -- --check  # solo lee
 *
 * `--check` es una prueba de vuelo de SOLO LECTURA (no muta): responde «¿quedan
 * secretos TOTP bajo una clave retirada?» ANTES de eliminar una clave del keyring.
 * Corre con el pool `fluvia_auth` (mínimo privilegio, NO superusuario — `users` es
 * global y `fluvia_auth` ya lee/escribe toda la tabla). Idempotente y reanudable.
 */

const checkOnly = process.argv.includes('--check');
const config = loadConfig();
const pool = createPool({ connectionString: config.db.auth });
const keyring = {
  current: config.mfaSecretKey,
  retired: config.mfaSecretKeysRetired,
};

if (keyring.retired.length === 0 && !checkOnly) {
  console.warn(
    'MFA_SECRET_KEY_RETIRED is empty: nothing to migrate FROM. ' +
      'Set the OLD key as retired and the NEW key as current before re-encrypting.'
  );
}

try {
  if (checkOnly) {
    const s = await inspectMfaSecretKeys(pool, keyring);
    console.log(
      `MFA enc-key check: total=${s.total} underCurrent=${s.underCurrent} ` +
        `underRetired=${s.underRetired} undecryptable=${s.undecryptable}`
    );
    if (s.undecryptable > 0) {
      console.warn(
        `WARNING: ${s.undecryptable} user(s) under NO keyring key — investigate before ` +
          `removing any key. ids: ${s.undecryptableIds.join(', ')}`
      );
    }
    if (s.total > 0 && s.underRetired === 0 && s.undecryptable === 0) {
      console.log(
        'all TOTP secrets under the current key — safe to REMOVE MFA_SECRET_KEY_RETIRED and redeploy.'
      );
    } else if (s.underRetired > 0) {
      console.log(
        `${s.underRetired} user(s) still under a retired key — run without --check to migrate.`
      );
    }
  } else {
    const res = await reencryptMfaSecrets(pool, keyring);
    console.log(
      `MFA enc-key re-encrypt: total=${res.total} reencrypted=${res.reencrypted} ` +
        `alreadyCurrent=${res.alreadyCurrent} failed=${res.failed}`
    );
    if (res.failed > 0) {
      console.warn(
        `WARNING: ${res.failed} user(s) under NO keyring key were skipped (not migrated) — ` +
          `investigate before removing any key. ids: ${res.failedIds.join(', ')}`
      );
    }
    if (res.reencrypted === 0 && res.failed === 0 && res.total > 0 && keyring.retired.length > 0) {
      console.log(
        'all TOTP secrets already under the current key — safe to REMOVE MFA_SECRET_KEY_RETIRED and redeploy.'
      );
    }
  }
} finally {
  await pool.end();
}
