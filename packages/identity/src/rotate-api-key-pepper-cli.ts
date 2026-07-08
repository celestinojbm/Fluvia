import { loadConfig } from '@fluvia/config';
import { createPool } from '@fluvia/db';
import { apiKeyPepperFingerprint } from './api-keys.js';
import { backfillApiKeyPepperFp, inspectApiKeyPepper } from './rotate-api-key-pepper.js';

/**
 * CLI de rotación del pepper HMAC de API keys (F6, ADR-0012). Runbook:
 * `docs/ops/runbooks/api-key-pepper-rotation.md`. El pepper es ONE-WAY, así que el
 * re-hash pepper-viejo→nuevo es PEREZOSO (en `authenticate_api_key` al autenticar);
 * este CLI NO re-hashea en bloque — aporta el GATE de retiro y el backfill inicial:
 *
 *   pnpm --filter @fluvia/identity run rotate:api-key-pepper -- --backfill  # 1 vez, pre-rotación
 *   pnpm --filter @fluvia/identity run rotate:api-key-pepper -- --check     # gate de retiro
 *
 * Corre con el pool ADMIN (`api_keys` tiene RLS por-tenant; cruzar tenants exige
 * superusuario — igual que el barrido de webhooks).
 */

const mode = process.argv.includes('--backfill') ? 'backfill' : 'check';
const config = loadConfig();

// GUARD DURO (no solo prosa): el backfill estampa la huella del pepper ACTUAL en las
// filas sin huella ASUMIENDO que su `key_hash` lo produjo el pepper actual — cierto SOLO
// antes de la primera rotación. Con peppers RETIRADOS configurados, una fila podría estar
// bajo un retirado y quedar marcada como «actual» → envenena el gate («safe» en falso) →
// al borrar ese pepper esas keys dejan de autenticar. Se rechaza para hacerlo imposible.
if (mode === 'backfill' && config.apiKeyHmacSecretsRetired.length > 0) {
  console.error(
    'refuse: --backfill con API_KEY_HMAC_SECRET_RETIRED configurado. El backfill solo es ' +
      'seguro ANTES de la primera rotación (sin peppers retirados). Córrelo una vez tras ' +
      'desplegar la migración 0044 y nunca más.'
  );
  process.exit(1);
}

const pool = createPool({ connectionString: config.db.admin });
const currentFp = apiKeyPepperFingerprint(config.apiKeyHmacSecret);
const retiredFps = config.apiKeyHmacSecretsRetired.map(apiKeyPepperFingerprint);

try {
  if (mode === 'backfill') {
    const res = await backfillApiKeyPepperFp(pool, currentFp);
    console.log(
      `api-key pepper backfill: marked ${res.updated} v2 key(s) as under the current pepper.`
    );
    console.log('Run this ONCE before the first rotation; then --check reads a precise gate.');
  } else {
    const s = await inspectApiKeyPepper(pool, { currentFp, retiredFps });
    console.log(
      `api-key pepper check: live=${s.total} underCurrent=${s.underCurrent} ` +
        `underRetired=${s.underRetired} unmarked=${s.unmarked} unknown=${s.unknown} legacyV1=${s.legacyV1}`
    );
    if (s.unmarked > 0) {
      console.warn(
        `WARNING: ${s.unmarked} v2 key(s) have NO pepper fingerprint — run --backfill before trusting the gate.`
      );
    }
    if (s.unknown > 0) {
      console.warn(
        `WARNING: ${s.unknown} key(s) under a pepper NOT in the keyring — add the missing pepper to ` +
          `API_KEY_HMAC_SECRET_RETIRED (or these keys can no longer authenticate). ids: ${s.stragglerIds.join(', ')}`
      );
    }
    if (s.underRetired === 0 && s.unmarked === 0 && s.unknown === 0) {
      console.log(
        'no live key is under a retired pepper — safe to REMOVE API_KEY_HMAC_SECRET_RETIRED and redeploy.'
      );
    } else if (s.underRetired > 0) {
      console.log(
        `${s.underRetired} live key(s) still under a retired pepper — they migrate on next auth; ` +
          `revoke the dormant stragglers to reach 0. ids: ${s.stragglerIds.join(', ')}`
      );
    }
  }
} finally {
  await pool.end();
}
