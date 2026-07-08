import { loadConfig } from '@fluvia/config';
import { createPool } from '@fluvia/db';
import { inspectWebhookSecretKeys, reencryptWebhookSecrets } from './rotate.js';

/**
 * CLI de rotación de la clave de cifrado de webhooks (F6, ADR-0012). Runbook:
 * `docs/ops/runbooks/webhook-enc-key-rotation.md`. Con la clave nueva ya como
 * ACTUAL (`WEBHOOK_SECRET_ENC_KEY`) y la vieja como RETIRADA
 * (`WEBHOOK_SECRET_ENC_KEY_RETIRED`):
 *
 *   pnpm --filter @fluvia/webhooks run rotate:webhook-key           # re-cifra
 *   pnpm --filter @fluvia/webhooks run rotate:webhook-key -- --check # solo lee
 *
 * `--check` es una prueba de vuelo de SOLO LECTURA (no muta): responde «¿quedan
 * blobs bajo una clave retirada?» ANTES de eliminar una clave del keyring. Corre
 * con el pool ADMIN (cruza tenants). El barrido es idempotente y reanudable.
 */

const checkOnly = process.argv.includes('--check');
const config = loadConfig();
const pool = createPool({ connectionString: config.db.admin });
const keyring = {
  current: config.webhookSecretEncKey,
  retired: config.webhookSecretEncKeysRetired,
};

if (keyring.retired.length === 0 && !checkOnly) {
  console.warn(
    'WEBHOOK_SECRET_ENC_KEY_RETIRED is empty: nothing to migrate FROM. ' +
      'Set the OLD key as retired and the NEW key as current before re-encrypting.'
  );
}

try {
  if (checkOnly) {
    const s = await inspectWebhookSecretKeys(pool, keyring);
    console.log(
      `webhook enc-key check: total=${s.total} underCurrent=${s.underCurrent} ` +
        `underRetired=${s.underRetired} undecryptable=${s.undecryptable}`
    );
    if (s.undecryptable > 0) {
      console.warn(
        `WARNING: ${s.undecryptable} endpoint(s) under NO keyring key — investigate before ` +
          `removing any key. ids: ${s.undecryptableIds.join(', ')}`
      );
    }
    if (s.total > 0 && s.underRetired === 0 && s.undecryptable === 0) {
      console.log(
        'all secrets under the current key — safe to REMOVE WEBHOOK_SECRET_ENC_KEY_RETIRED and redeploy.'
      );
    } else if (s.underRetired > 0) {
      console.log(
        `${s.underRetired} endpoint(s) still under a retired key — run without --check to migrate.`
      );
    }
  } else {
    const res = await reencryptWebhookSecrets(pool, keyring);
    console.log(
      `webhook enc-key re-encrypt: total=${res.total} reencrypted=${res.reencrypted} ` +
        `alreadyCurrent=${res.alreadyCurrent} failed=${res.failed}`
    );
    if (res.failed > 0) {
      console.warn(
        `WARNING: ${res.failed} endpoint(s) under NO keyring key were skipped (not migrated) — ` +
          `investigate before removing any key. ids: ${res.failedIds.join(', ')}`
      );
    }
    if (res.reencrypted === 0 && res.failed === 0 && res.total > 0 && keyring.retired.length > 0) {
      console.log(
        'all secrets already under the current key — safe to REMOVE WEBHOOK_SECRET_ENC_KEY_RETIRED and redeploy.'
      );
    }
  }
} finally {
  await pool.end();
}
