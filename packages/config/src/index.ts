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
  REDIS_URL: z.string().min(1).optional(),
  MFA_SECRET_KEY: z
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
});

/** Defaults SOLO para local/test (coinciden con docker-compose). */
const LOCAL_DEFAULTS = {
  // Clave SOLO local (regimen R-12): patron obvio, jamas usable fuera de local.
  mfaSecretKey: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff', // gitleaks:allow
  admin: 'postgres://postgres:postgres@127.0.0.1:5432/fluvia',
  app: 'postgres://fluvia_app:fluvia_app_dev_password@127.0.0.1:5432/fluvia',
  worker: 'postgres://fluvia_worker:fluvia_worker_dev_password@127.0.0.1:5432/fluvia',
  relay: 'postgres://fluvia_relay:fluvia_relay_dev_password@127.0.0.1:5432/fluvia',
  auth: 'postgres://fluvia_auth:fluvia_auth_dev_password@127.0.0.1:5432/fluvia',
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
  };
  redisUrl: string;
  /** Clave AES-256-GCM (64 hex) para secretos TOTP en reposo (F1-04b). */
  mfaSecretKey: string;
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
    },
    redisUrl: required('REDIS_URL', e.REDIS_URL, LOCAL_DEFAULTS.redis),
    mfaSecretKey: required('MFA_SECRET_KEY', e.MFA_SECRET_KEY, LOCAL_DEFAULTS.mfaSecretKey),
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
  };
}
