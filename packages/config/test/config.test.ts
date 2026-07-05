import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/index.js';

describe('loadConfig', () => {
  it('applies safe defaults in local', () => {
    const cfg = loadConfig({});
    expect(cfg.env).toBe('local');
    expect(cfg.port).toBe(3000);
    expect(cfg.logLevel).toBe('info');
    expect(cfg.db.app).toContain('fluvia_app');
  });

  it('coerces PORT and validates its range', () => {
    expect(loadConfig({ PORT: '8080' }).port).toBe(8080);
    expect(() => loadConfig({ PORT: '0' })).toThrow(ConfigError);
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(ConfigError);
  });

  it('rejects unknown NODE_ENV and LOG_LEVEL', () => {
    expect(() => loadConfig({ NODE_ENV: 'prod' })).toThrow(ConfigError);
    expect(() => loadConfig({ LOG_LEVEL: 'verbose' })).toThrow(ConfigError);
  });

  it('forbids development defaults outside local/test (credential mixing)', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/ADMIN_DATABASE_URL/);
    expect(() =>
      loadConfig({
        NODE_ENV: 'sandbox',
        ADMIN_DATABASE_URL: 'postgres://x',
        APP_DATABASE_URL: 'postgres://y',
        WORKER_DATABASE_URL: 'postgres://z',
      })
    ).toThrow(/RELAY_DATABASE_URL/);
    expect(() =>
      loadConfig({
        NODE_ENV: 'sandbox',
        ADMIN_DATABASE_URL: 'postgres://x',
        APP_DATABASE_URL: 'postgres://y',
        WORKER_DATABASE_URL: 'postgres://z',
        RELAY_DATABASE_URL: 'postgres://w',
      })
    ).toThrow(/AUTH_DATABASE_URL/);
    expect(() =>
      loadConfig({
        NODE_ENV: 'sandbox',
        ADMIN_DATABASE_URL: 'postgres://x',
        APP_DATABASE_URL: 'postgres://y',
        WORKER_DATABASE_URL: 'postgres://z',
        RELAY_DATABASE_URL: 'postgres://w',
        AUTH_DATABASE_URL: 'postgres://a',
      })
    ).toThrow(/INBOX_DATABASE_URL/);
    expect(() =>
      loadConfig({
        NODE_ENV: 'sandbox',
        ADMIN_DATABASE_URL: 'postgres://x',
        APP_DATABASE_URL: 'postgres://y',
        WORKER_DATABASE_URL: 'postgres://z',
        RELAY_DATABASE_URL: 'postgres://w',
        AUTH_DATABASE_URL: 'postgres://a',
        INBOX_DATABASE_URL: 'postgres://i',
      })
    ).toThrow(/WEBHOOK_DATABASE_URL/);
    expect(() =>
      loadConfig({
        NODE_ENV: 'sandbox',
        ADMIN_DATABASE_URL: 'postgres://x',
        APP_DATABASE_URL: 'postgres://y',
        WORKER_DATABASE_URL: 'postgres://z',
        RELAY_DATABASE_URL: 'postgres://w',
        AUTH_DATABASE_URL: 'postgres://a',
        INBOX_DATABASE_URL: 'postgres://i',
        WEBHOOK_DATABASE_URL: 'postgres://h',
      })
    ).toThrow(/REDIS_URL/);
    // F1-04b: la clave de cifrado MFA tambien es anti-mezcla.
    expect(() =>
      loadConfig({
        NODE_ENV: 'sandbox',
        ADMIN_DATABASE_URL: 'postgres://x',
        APP_DATABASE_URL: 'postgres://y',
        WORKER_DATABASE_URL: 'postgres://z',
        RELAY_DATABASE_URL: 'postgres://w',
        AUTH_DATABASE_URL: 'postgres://a',
        INBOX_DATABASE_URL: 'postgres://i',
        WEBHOOK_DATABASE_URL: 'postgres://h',
        REDIS_URL: 'redis://r',
      })
    ).toThrow(/MFA_SECRET_KEY/);
    // AUD-P2-015: el pepper HMAC de API keys tambien es anti-mezcla.
    expect(() =>
      loadConfig({
        NODE_ENV: 'sandbox',
        ADMIN_DATABASE_URL: 'postgres://x',
        APP_DATABASE_URL: 'postgres://y',
        WORKER_DATABASE_URL: 'postgres://z',
        RELAY_DATABASE_URL: 'postgres://w',
        AUTH_DATABASE_URL: 'postgres://a',
        INBOX_DATABASE_URL: 'postgres://i',
        WEBHOOK_DATABASE_URL: 'postgres://h',
        REDIS_URL: 'redis://r',
        MFA_SECRET_KEY: 'a'.repeat(64),
      })
    ).toThrow(/API_KEY_HMAC_SECRET/);
    // F3-03b: el secreto de webhooks del MockProvider tambien.
    expect(() =>
      loadConfig({
        NODE_ENV: 'sandbox',
        ADMIN_DATABASE_URL: 'postgres://x',
        APP_DATABASE_URL: 'postgres://y',
        WORKER_DATABASE_URL: 'postgres://z',
        RELAY_DATABASE_URL: 'postgres://w',
        AUTH_DATABASE_URL: 'postgres://a',
        INBOX_DATABASE_URL: 'postgres://i',
        WEBHOOK_DATABASE_URL: 'postgres://h',
        REDIS_URL: 'redis://r',
        MFA_SECRET_KEY: 'a'.repeat(64),
        API_KEY_HMAC_SECRET: 'b'.repeat(64),
      })
    ).toThrow(/MOCK_WEBHOOK_SECRET/);
    // F3-07: la clave de cifrado de secretos de endpoints tambien.
    expect(() =>
      loadConfig({
        NODE_ENV: 'sandbox',
        ADMIN_DATABASE_URL: 'postgres://x',
        APP_DATABASE_URL: 'postgres://y',
        WORKER_DATABASE_URL: 'postgres://z',
        RELAY_DATABASE_URL: 'postgres://w',
        AUTH_DATABASE_URL: 'postgres://a',
        INBOX_DATABASE_URL: 'postgres://i',
        WEBHOOK_DATABASE_URL: 'postgres://h',
        REDIS_URL: 'redis://r',
        MFA_SECRET_KEY: 'a'.repeat(64),
        API_KEY_HMAC_SECRET: 'b'.repeat(64),
        MOCK_WEBHOOK_SECRET: 'whsec_explicit_secret_value',
      })
    ).toThrow(/WEBHOOK_SECRET_ENC_KEY/);
  });

  it('accepts fully explicit non-local config', () => {
    const cfg = loadConfig({
      NODE_ENV: 'production',
      ADMIN_DATABASE_URL: 'postgres://a',
      APP_DATABASE_URL: 'postgres://b',
      WORKER_DATABASE_URL: 'postgres://c',
      RELAY_DATABASE_URL: 'postgres://e',
      AUTH_DATABASE_URL: 'postgres://d',
      REDIS_URL: 'redis://r',
      MFA_SECRET_KEY: 'a'.repeat(64),
      API_KEY_HMAC_SECRET: 'b'.repeat(64),
      INBOX_DATABASE_URL: 'postgres://i',
      WEBHOOK_DATABASE_URL: 'postgres://h',
      MOCK_WEBHOOK_SECRET: 'whsec_explicit_secret_value',
      WEBHOOK_SECRET_ENC_KEY: 'c'.repeat(64),
    });
    expect(cfg.env).toBe('production');
    expect(cfg.db.inbox).toBe('postgres://i');
    expect(cfg.db.worker).toBe('postgres://c');
    expect(cfg.db.relay).toBe('postgres://e');
  });

  it('parses relay toggles with safe defaults', () => {
    const cfg = loadConfig({});
    expect(cfg.relay).toEqual({ enabled: true, intervalMs: 1000 });
    expect(loadConfig({ RELAY_ENABLED: 'false' }).relay.enabled).toBe(false);
    expect(loadConfig({ RELAY_INTERVAL_MS: '250' }).relay.intervalMs).toBe(250);
    expect(() => loadConfig({ RELAY_INTERVAL_MS: '5' })).toThrow(ConfigError);
    expect(() => loadConfig({ RELAY_ENABLED: 'yes' })).toThrow(ConfigError);
  });

  it('parses drift-check toggles with safe defaults', () => {
    const cfg = loadConfig({});
    expect(cfg.driftCheck).toEqual({ enabled: true, intervalMs: 60_000 });
    expect(loadConfig({ DRIFT_CHECK_ENABLED: 'false' }).driftCheck.enabled).toBe(false);
    expect(loadConfig({ DRIFT_CHECK_INTERVAL_MS: '5000' }).driftCheck.intervalMs).toBe(5000);
    expect(() => loadConfig({ DRIFT_CHECK_INTERVAL_MS: '10' })).toThrow(ConfigError);
  });

  it('parses the worker metrics port with the standard default (F1-07)', () => {
    expect(loadConfig({}).workerMetricsPort).toBe(9464);
    expect(loadConfig({ WORKER_METRICS_PORT: '9100' }).workerMetricsPort).toBe(9100);
    expect(() => loadConfig({ WORKER_METRICS_PORT: '0' })).toThrow(ConfigError);
  });

  it('parses inbox-processor toggles with safe defaults (F3-03b)', () => {
    expect(loadConfig({}).inbox).toEqual({ enabled: true, intervalMs: 1000 });
    expect(loadConfig({ INBOX_ENABLED: 'false' }).inbox.enabled).toBe(false);
    expect(() => loadConfig({ INBOX_INTERVAL_MS: '5' })).toThrow(ConfigError);
    expect(() => loadConfig({ MOCK_WEBHOOK_SECRET: 'short' })).toThrow(ConfigError);
  });

  it('parses attempts-watchdog toggles with safe defaults (F3-04)', () => {
    expect(loadConfig({}).attemptsWatchdog).toEqual({ enabled: true, intervalMs: 60_000 });
    expect(loadConfig({ ATTEMPTS_WATCHDOG_ENABLED: 'false' }).attemptsWatchdog.enabled).toBe(false);
    expect(() => loadConfig({ ATTEMPTS_WATCHDOG_INTERVAL_MS: '10' })).toThrow(ConfigError);
  });

  it('parses purge-job toggles with safe defaults (F1-09)', () => {
    expect(loadConfig({}).purge).toEqual({ enabled: true, intervalMs: 3_600_000 });
    expect(loadConfig({ PURGE_ENABLED: 'false' }).purge.enabled).toBe(false);
    expect(loadConfig({ PURGE_INTERVAL_MS: '60000' }).purge.intervalMs).toBe(60_000);
    expect(() => loadConfig({ PURGE_INTERVAL_MS: '10' })).toThrow(ConfigError);
  });

  it('treats empty string as missing (no silent empty credentials)', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', ADMIN_DATABASE_URL: '' })).toThrow(
      ConfigError
    );
  });
});
