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
    ).toThrow(/AUTH_DATABASE_URL/);
    expect(() =>
      loadConfig({
        NODE_ENV: 'sandbox',
        ADMIN_DATABASE_URL: 'postgres://x',
        APP_DATABASE_URL: 'postgres://y',
        WORKER_DATABASE_URL: 'postgres://z',
        AUTH_DATABASE_URL: 'postgres://a',
      })
    ).toThrow(/REDIS_URL/);
  });

  it('accepts fully explicit non-local config', () => {
    const cfg = loadConfig({
      NODE_ENV: 'production',
      ADMIN_DATABASE_URL: 'postgres://a',
      APP_DATABASE_URL: 'postgres://b',
      WORKER_DATABASE_URL: 'postgres://c',
      AUTH_DATABASE_URL: 'postgres://d',
      REDIS_URL: 'redis://r',
    });
    expect(cfg.env).toBe('production');
    expect(cfg.db.worker).toBe('postgres://c');
  });

  it('treats empty string as missing (no silent empty credentials)', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', ADMIN_DATABASE_URL: '' })).toThrow(
      ConfigError
    );
  });
});
