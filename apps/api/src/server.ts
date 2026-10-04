import { createClient } from 'redis';
import { loadConfig } from '@fluvia/config';
import { createPool } from '@fluvia/db';
import { AuthService } from '@fluvia/auth';
import { ApiKeyService, IdentityService } from '@fluvia/identity';
import { buildApp } from './app.js';
import { RedisFixedWindowLimiter } from './rate-limit.js';
import { RedisConcurrencyGate } from '@fluvia/assistant';
import { FxService } from './fx/service.js';
import { FxRefresher, fxRefreshConfigFromEnv } from './fx/refresher.js';

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

// Tasas de referencia: un servicio compartido por la ruta y el refresco.
const fxCfg = fxRefreshConfigFromEnv(process.env);
const fx = new FxService(appPool, {
  refreshEnabled: fxCfg.enabled,
  bcvIntervalSeconds: fxCfg.bcvIntervalSeconds,
  usdtIntervalSeconds: fxCfg.usdtIntervalSeconds,
  coingeckoKey: fxCfg.coingeckoApiKey ? (fxCfg.coingeckoPro ? 'pro' : 'demo') : 'sin_clave',
});

const app = buildApp({
  config,
  appPool,
  adminPool,
  authPool,
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
  // Varias réplicas: la concurrencia del asistente se coordina en Redis.
  assistant: { concurrency: new RedisConcurrencyGate(redis) },
  fx,
  // Escenarios sandbox de la red Fluvia (respuesta perdida en importes que
  // terminan en 13). La API lo ignora fuera de local/test.
  sandboxScenarios: process.env.SANDBOX_SCENARIOS === '1',
});

const fxRefresher = new FxRefresher(appPool, fx, fxCfg, app.log);
fxRefresher.start();

redis.on('error', (err) => app.log.error({ err }, 'redis client error (rate limiter)'));
redis.connect().catch((err) => {
  app.log.error({ err }, 'redis connect failed — rate limiter running FAIL-OPEN');
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'graceful shutdown started');
  fxRefresher.stop();
  await app.close();
  redis.destroy();
  await Promise.all([appPool.end(), authPool.end(), adminPool.end()]);
  process.exit(0);
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => void shutdown(signal));
}

// `HOST` opcional: la demo local lo fija a 127.0.0.1 para no exponer la API en
// la LAN. Sin la variable, el comportamiento es el de siempre (0.0.0.0).
app.listen({ port: config.port, host: process.env.HOST || '0.0.0.0' }).catch((err) => {
  app.log.fatal({ err }, 'failed to start api');
  process.exit(1);
});
