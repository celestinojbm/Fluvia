import { describe, expect, it } from 'vitest';
import { dbUrlsFromEnv } from '../src/config.js';

/**
 * AUD-P2-014 — anti-mezcla de entornos: los defaults con credenciales dev
 * solo aplican en local/test; en cualquier otro entorno el arranque DEBE
 * fallar si falta alguna URL explicita.
 */
describe('dbUrlsFromEnv', () => {
  it('falls back to local defaults in dev/test environments', () => {
    for (const env of [{}, { NODE_ENV: 'test' }, { NODE_ENV: 'development' }]) {
      const urls = dbUrlsFromEnv(env as NodeJS.ProcessEnv);
      expect(urls.admin).toContain('127.0.0.1');
      expect(urls.app).toContain('fluvia_app');
    }
  });

  it('throws in staging/production when any URL is missing (no silent dev defaults)', () => {
    expect(() => dbUrlsFromEnv({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toThrow(
      /FLUVIA_CONFIG.*ADMIN_DATABASE_URL/
    );
    expect(() =>
      dbUrlsFromEnv({
        FLUVIA_ENV: 'staging',
        ADMIN_DATABASE_URL: 'postgres://a',
        APP_DATABASE_URL: 'postgres://b',
        // WORKER_DATABASE_URL y RELAY_DATABASE_URL ausentes
        AUTH_DATABASE_URL: 'postgres://d',
      } as NodeJS.ProcessEnv)
    ).toThrow(/WORKER_DATABASE_URL.*RELAY_DATABASE_URL|RELAY_DATABASE_URL.*WORKER_DATABASE_URL/);
  });

  it('accepts non-local environments when every URL is explicit', () => {
    const urls = dbUrlsFromEnv({
      FLUVIA_ENV: 'staging',
      ADMIN_DATABASE_URL: 'postgres://a',
      APP_DATABASE_URL: 'postgres://b',
      WORKER_DATABASE_URL: 'postgres://c',
      RELAY_DATABASE_URL: 'postgres://r',
      INBOX_DATABASE_URL: 'postgres://i',
      AUTH_DATABASE_URL: 'postgres://d',
      WEBHOOK_DATABASE_URL: 'postgres://w',
    } as NodeJS.ProcessEnv);
    expect(urls.worker).toBe('postgres://c');
    expect(urls.relay).toBe('postgres://r');
    expect(urls.inbox).toBe('postgres://i');
    expect(urls.webhook).toBe('postgres://w');
  });

  it('FLUVIA_ENV takes precedence over NODE_ENV', () => {
    // CI corre con NODE_ENV=test pero un despliegue mal etiquetado no debe colarse.
    expect(() =>
      dbUrlsFromEnv({ NODE_ENV: 'test', FLUVIA_ENV: 'production' } as NodeJS.ProcessEnv)
    ).toThrow(/FLUVIA_CONFIG/);
  });
});
