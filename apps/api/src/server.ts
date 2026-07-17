import { createClient } from 'redis';
import { loadConfig } from '@fluvia/config';
import { createPool } from '@fluvia/db';
import { AuthService } from '@fluvia/auth';
import { ApiKeyService, IdentityService } from '@fluvia/identity';
import { buildApp } from './app.js';
import { RedisFixedWindowLimiter } from './rate-limit.js';

const config = loadConfig();
const appPool = createPool({ connectionString: config.db.app });
const authPool = createPool({ connectionString: config.db.auth, max: 5 });
// F6.5C2: plano de plataforma SOLO para el onboarding de organizacion
// (createOrganizationForUser). Pool minimo — no es un canal generico de admin.
const adminPool = createPool({ connectionString: config.db.admin, max: 2 });

// TM-03 (ADR-0002): el rate limiter de /v1/auth/* usa Redis como store
// COMPARTIDO entre instancias. La conexion se establece en background y el
// limiter FALLA ABIERTO mientras Redis no este disponible (control de abuso,
// no invariante financiera — una caida de Redis no tumba el login), dejando
// el fallo visible en logs. `REDIS_URL` es exigida fuera de local/test por
// la config anti-mezcla (V4 §43).
const redis = createClient({ url: config.redisUrl });
const rateLimiter = new RedisFixedWindowLimiter(redis, {
  onError: (err) => app.log.error({ err }, 'rate limiter fail-open: redis unavailable'),
});

const app = buildApp({
  config,
  appPool,
  adminPool,
  authService: new AuthService(authPool, {
    mfaEncryptionKeyHex: config.mfaSecretKey,
    retiredMfaKeyHexes: config.mfaSecretKeysRetired,
    sessionIdleTimeoutMs: config.sessionIdleTimeoutMs,
    // F6.5C1 (B6): capacidad de registro sandbox atomico — SOLO local/test,
    // misma fuente normativa de entorno que el gating de la ruta en app.ts.
    allowSandboxRegistration: config.env === 'local' || config.env === 'test',
  }),
  identityService: new IdentityService(appPool),
  apiKeyService: new ApiKeyService(appPool, { hmacSecretHex: config.apiKeyHmacSecret }),
  rateLimiter,
});

redis.on('error', (err) => app.log.error({ err }, 'redis client error (rate limiter)'));
redis.connect().catch((err) => {
  app.log.error({ err }, 'redis connect failed — rate limiter running FAIL-OPEN');
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'graceful shutdown started');
  await app.close();
  redis.destroy();
  await Promise.all([appPool.end(), authPool.end(), adminPool.end()]);
  process.exit(0);
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => void shutdown(signal));
}

app.listen({ port: config.port, host: '0.0.0.0' }).catch((err) => {
  app.log.fatal({ err }, 'failed to start api');
  process.exit(1);
});
