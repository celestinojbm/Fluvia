import { z } from 'zod';

/**
 * Configuracion tipada de Fluvia (V4 §43).
 *
 * Reglas:
 *  - Falla rapido: configuracion invalida = el proceso no arranca.
 *  - Anti-mezcla de credenciales: en entornos no locales (sandbox/staging/
 *    production) TODAS las URLs de infraestructura deben venir explicitas
 *    por entorno; los defaults de desarrollo solo aplican en local/test.
 */

export const ENVIRONMENTS = ['local', 'test', 'sandbox', 'staging', 'production'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

const EnvSchema = z.object({
  NODE_ENV: z.enum(ENVIRONMENTS).default('local'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  ADMIN_DATABASE_URL: z.string().min(1).optional(),
  APP_DATABASE_URL: z.string().min(1).optional(),
  WORKER_DATABASE_URL: z.string().min(1).optional(),
  RELAY_DATABASE_URL: z.string().min(1).optional(),
  AUTH_DATABASE_URL: z.string().min(1).optional(),
  INBOX_DATABASE_URL: z.string().min(1).optional(),
  WEBHOOK_DATABASE_URL: z.string().min(1).optional(),
  REDIS_URL: z.string().min(1).optional(),
  MFA_SECRET_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, 'must be 64 hex chars')
    .optional(),
  API_KEY_HMAC_SECRET: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, 'must be 64 hex chars')
    .optional(),
  RELAY_ENABLED: z.enum(['true', 'false']).default('true'),
  RELAY_INTERVAL_MS: z.coerce.number().int().min(50).max(60_000).default(1000),
  DRIFT_CHECK_ENABLED: z.enum(['true', 'false']).default('true'),
  DRIFT_CHECK_INTERVAL_MS: z.coerce.number().int().min(1000).max(3_600_000).default(60_000),
  WORKER_METRICS_PORT: z.coerce.number().int().min(1).max(65535).default(9464),
  PURGE_ENABLED: z.enum(['true', 'false']).default('true'),
  PURGE_INTERVAL_MS: z.coerce.number().int().min(1000).max(86_400_000).default(3_600_000),
  INBOX_ENABLED: z.enum(['true', 'false']).default('true'),
  INBOX_INTERVAL_MS: z.coerce.number().int().min(50).max(60_000).default(1000),
  ATTEMPTS_WATCHDOG_ENABLED: z.enum(['true', 'false']).default('true'),
  ATTEMPTS_WATCHDOG_INTERVAL_MS: z.coerce.number().int().min(1000).max(3_600_000).default(60_000),
  MOCK_WEBHOOK_SECRET: z.string().min(16).optional(),
  WEBHOOK_SECRET_ENC_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, 'must be 64 hex chars')
    .optional(),
  WEBHOOK_DELIVERY_ENABLED: z.enum(['true', 'false']).default('true'),
  WEBHOOK_DELIVERY_INTERVAL_MS: z.coerce.number().int().min(50).max(60_000).default(1000),
  // Base de la URL de checkout alojado (F3-05b); no es secreto.
  CHECKOUT_BASE_URL: z.string().url().default('https://checkout.fluvia.local'),
  CHECKOUT_WATCHDOG_ENABLED: z.enum(['true', 'false']).default('true'),
  CHECKOUT_WATCHDOG_INTERVAL_MS: z.coerce.number().int().min(1000).max(3_600_000).default(60_000),
  RECONCILIATION_WATCHDOG_ENABLED: z.enum(['true', 'false']).default('true'),
  RECONCILIATION_WATCHDOG_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(3_600_000)
    .default(60_000),
  PAYOUTS_WATCHDOG_ENABLED: z.enum(['true', 'false']).default('true'),
  PAYOUTS_WATCHDOG_INTERVAL_MS: z.coerce.number().int().min(1000).max(3_600_000).default(60_000),
  // F4-03b: umbral (unidades menores) desde el cual un ajuste de caso exige
  // four-eyes (segundo aprobador distinto). Default 0 = SIEMPRE (Nivel A seguro).
  FOUR_EYES_THRESHOLD_MINOR: z.coerce.number().int().min(0).default(0),
  // Fee de plataforma en basis points (F4-05c, PEND-002). Default 200 = 2%.
  PLATFORM_FEE_BPS: z.coerce.number().int().min(0).max(10_000).default(200),
  // CORS (F3-11a, AUD-P2-016): lista de orígenes permitidos separada por comas.
  // Vacío = NINGÚN cross-origin (default seguro; checkout/dashboard llaman al API
  // server-side, no desde el navegador). `*` permite cualquier origen. No secreto.
  CORS_ALLOWED_ORIGINS: z.string().default(''),
});

/** Defaults SOLO para local/test (coinciden con docker-compose). */
const LOCAL_DEFAULTS = {
  // Clave SOLO local (regimen R-12): patron obvio, jamas usable fuera de local.
  mfaSecretKey: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff', // gitleaks:allow
  apiKeyHmacSecret: 'ffeeddccbbaa00112233445566778899ffeeddccbbaa00112233445566778899', // gitleaks:allow
  admin: 'postgres://postgres:postgres@127.0.0.1:5432/fluvia',
  app: 'postgres://fluvia_app:fluvia_app_dev_password@127.0.0.1:5432/fluvia',
  worker: 'postgres://fluvia_worker:fluvia_worker_dev_password@127.0.0.1:5432/fluvia',
  relay: 'postgres://fluvia_relay:fluvia_relay_dev_password@127.0.0.1:5432/fluvia',
  auth: 'postgres://fluvia_auth:fluvia_auth_dev_password@127.0.0.1:5432/fluvia',
  inbox: 'postgres://fluvia_inbox:fluvia_inbox_dev_password@127.0.0.1:5432/fluvia',
  webhook: 'postgres://fluvia_webhook:fluvia_webhook_dev_password@127.0.0.1:5432/fluvia',
  webhookSecretEncKey: 'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899', // gitleaks:allow
  // Secreto de firma del MockProvider, SOLO local/test (regimen R-12).
  mockWebhookSecret: 'whsec_mock_dev_secret_00112233', // gitleaks:allow
  redis: 'redis://127.0.0.1:6379',
} as const;

export interface AppConfig {
  env: Environment;
  port: number;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  db: {
    admin: string;
    app: string;
    worker: string;
    relay: string;
    auth: string;
    inbox: string;
    webhook: string;
  };
  redisUrl: string;
  /** Clave AES-256-GCM (64 hex) para secretos TOTP en reposo (F1-04b). */
  mfaSecretKey: string;
  /** Pepper HMAC-SHA256 (64 hex) para hashes de API keys (AUD-P2-015). */
  apiKeyHmacSecret: string;
  relay: {
    enabled: boolean;
    intervalMs: number;
  };
  driftCheck: {
    enabled: boolean;
    intervalMs: number;
  };
  /** Puerto de /health y /metrics del worker (F1-07; default estandar 9464). */
  workerMetricsPort: number;
  /** Job de purga de datos tecnicos (F1-09; la politica vive en la BD). */
  purge: {
    enabled: boolean;
    intervalMs: number;
  };
  /** Procesador del inbox de webhooks entrantes (F3-03b). */
  inbox: {
    enabled: boolean;
    intervalMs: number;
  };
  /** Watchdog de attempts: barrido de submitting + salud de indeterminados (F3-04). */
  attemptsWatchdog: {
    enabled: boolean;
    intervalMs: number;
  };
  /** Secreto HMAC de los webhooks del MockProvider (F3-03b). */
  mockWebhookSecret: string;
  /** Clave AES-256-GCM (64 hex) para secretos de endpoints de webhook (F3-07). */
  webhookSecretEncKey: string;
  /** Deliverer de webhooks salientes (F3-07). */
  webhookDelivery: {
    enabled: boolean;
    intervalMs: number;
  };
  /** Base de la URL de checkout alojado (F3-05b); el buyer va a `{base}/c/{id}`. */
  checkoutBaseUrl: string;
  /** Watchdog de sesiones de checkout: entrega garantizada de eventos (F3-05c-ii). */
  checkoutWatchdog: {
    enabled: boolean;
    intervalMs: number;
  };
  /** Watchdog de conciliación: concilia reportes con periodo cerrado (F4-02). */
  reconciliationWatchdog: {
    enabled: boolean;
    intervalMs: number;
  };
  /** Watchdog de payouts: barrido de in_transit atascado + salud (F4-07c). */
  payoutsWatchdog: {
    enabled: boolean;
    intervalMs: number;
  };
  /** Umbral (unidades menores) desde el cual un ajuste de caso exige four-eyes (F4-03b). */
  fourEyesThresholdMinor: number;
  /** Fee de plataforma en basis points (F4-05c, PEND-002). 200 = 2%. */
  platformFeeBps: number;
  /** Orígenes CORS permitidos (F3-11a). Vacío = ningún cross-origin; `['*']` = todos. */
  corsAllowedOrigins: string[];
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new ConfigError(`Invalid environment configuration: ${detail}`);
  }
  const e = parsed.data;
  const isLocalLike = e.NODE_ENV === 'local' || e.NODE_ENV === 'test';

  const required = (name: string, value: string | undefined, localDefault: string): string => {
    if (value !== undefined && value !== '') return value;
    if (isLocalLike) return localDefault;
    throw new ConfigError(
      `${name} must be set explicitly in ${e.NODE_ENV} — development defaults are forbidden outside local/test (credential-mixing protection, V4 §43)`
    );
  };

  return {
    env: e.NODE_ENV,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    db: {
      admin: required('ADMIN_DATABASE_URL', e.ADMIN_DATABASE_URL, LOCAL_DEFAULTS.admin),
      app: required('APP_DATABASE_URL', e.APP_DATABASE_URL, LOCAL_DEFAULTS.app),
      worker: required('WORKER_DATABASE_URL', e.WORKER_DATABASE_URL, LOCAL_DEFAULTS.worker),
      relay: required('RELAY_DATABASE_URL', e.RELAY_DATABASE_URL, LOCAL_DEFAULTS.relay),
      auth: required('AUTH_DATABASE_URL', e.AUTH_DATABASE_URL, LOCAL_DEFAULTS.auth),
      inbox: required('INBOX_DATABASE_URL', e.INBOX_DATABASE_URL, LOCAL_DEFAULTS.inbox),
      webhook: required('WEBHOOK_DATABASE_URL', e.WEBHOOK_DATABASE_URL, LOCAL_DEFAULTS.webhook),
    },
    redisUrl: required('REDIS_URL', e.REDIS_URL, LOCAL_DEFAULTS.redis),
    mfaSecretKey: required('MFA_SECRET_KEY', e.MFA_SECRET_KEY, LOCAL_DEFAULTS.mfaSecretKey),
    apiKeyHmacSecret: required(
      'API_KEY_HMAC_SECRET',
      e.API_KEY_HMAC_SECRET,
      LOCAL_DEFAULTS.apiKeyHmacSecret
    ),
    relay: {
      enabled: e.RELAY_ENABLED === 'true',
      intervalMs: e.RELAY_INTERVAL_MS,
    },
    driftCheck: {
      enabled: e.DRIFT_CHECK_ENABLED === 'true',
      intervalMs: e.DRIFT_CHECK_INTERVAL_MS,
    },
    workerMetricsPort: e.WORKER_METRICS_PORT,
    purge: {
      enabled: e.PURGE_ENABLED === 'true',
      intervalMs: e.PURGE_INTERVAL_MS,
    },
    inbox: {
      enabled: e.INBOX_ENABLED === 'true',
      intervalMs: e.INBOX_INTERVAL_MS,
    },
    attemptsWatchdog: {
      enabled: e.ATTEMPTS_WATCHDOG_ENABLED === 'true',
      intervalMs: e.ATTEMPTS_WATCHDOG_INTERVAL_MS,
    },
    mockWebhookSecret: required(
      'MOCK_WEBHOOK_SECRET',
      e.MOCK_WEBHOOK_SECRET,
      LOCAL_DEFAULTS.mockWebhookSecret
    ),
    webhookSecretEncKey: required(
      'WEBHOOK_SECRET_ENC_KEY',
      e.WEBHOOK_SECRET_ENC_KEY,
      LOCAL_DEFAULTS.webhookSecretEncKey
    ),
    webhookDelivery: {
      enabled: e.WEBHOOK_DELIVERY_ENABLED === 'true',
      intervalMs: e.WEBHOOK_DELIVERY_INTERVAL_MS,
    },
    checkoutBaseUrl: e.CHECKOUT_BASE_URL,
    checkoutWatchdog: {
      enabled: e.CHECKOUT_WATCHDOG_ENABLED === 'true',
      intervalMs: e.CHECKOUT_WATCHDOG_INTERVAL_MS,
    },
    reconciliationWatchdog: {
      enabled: e.RECONCILIATION_WATCHDOG_ENABLED === 'true',
      intervalMs: e.RECONCILIATION_WATCHDOG_INTERVAL_MS,
    },
    payoutsWatchdog: {
      enabled: e.PAYOUTS_WATCHDOG_ENABLED === 'true',
      intervalMs: e.PAYOUTS_WATCHDOG_INTERVAL_MS,
    },
    fourEyesThresholdMinor: e.FOUR_EYES_THRESHOLD_MINOR,
    platformFeeBps: e.PLATFORM_FEE_BPS,
    corsAllowedOrigins: e.CORS_ALLOWED_ORIGINS.split(',')
      .map((o) => o.trim())
      .filter((o) => o.length > 0),
  };
}
