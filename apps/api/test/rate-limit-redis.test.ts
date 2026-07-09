import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from 'redis';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@fluvia/config';
import { createPool, type Pool } from '@fluvia/db';
import { AuthService } from '@fluvia/auth';
import { RedisFixedWindowLimiter, type RedisEvalClient } from '../src/rate-limit.js';
import { buildApp } from '../src/app.js';

/**
 * TM-03 (threat model §5) — rate limiter en store COMPARTIDO (Redis, ADR-0002).
 *
 * El punto entero del incremento: N instancias del API comparten UNA ventana —
 * sin esto, N instancias multiplican el presupuesto de fuerza bruta por N. Se
 * prueba (a) fail-open ante un backend roto (unit, stub), (b) la ventana
 * compartida entre DOS instancias del limiter sobre Redis REAL, con expiración,
 * y (c) el caso end-to-end: DOS apps Fastify distintas compartiendo presupuesto
 * de login. En CI, `REDIS_URL` apunta al service container redis:7; en local, a
 * la instancia de docker-compose. Sin Redis alcanzable, la parte real se salta
 * (la ejecución definitiva es CI, como el restore drill).
 */

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

describe('RedisFixedWindowLimiter — fail-open (unit, sin Redis)', () => {
  it('a broken backend fails OPEN and reports the error (never blocks auth)', async () => {
    const errors: unknown[] = [];
    const broken: RedisEvalClient = {
      eval: async () => {
        throw new Error('redis down');
      },
    };
    const limiter = new RedisFixedWindowLimiter(broken, { onError: (e) => errors.push(e) });
    expect(await limiter.hit('k', { max: 1, windowMs: 1000 })).toBeNull();
    expect(await limiter.hit('k', { max: 1, windowMs: 1000 })).toBeNull();
    expect(errors).toHaveLength(2); // fail-open, pero JAMÁS en silencio
  });
});

describe('RedisFixedWindowLimiter — ventana compartida (Redis real)', () => {
  let clientA: ReturnType<typeof createClient>;
  let clientB: ReturnType<typeof createClient>;
  let available = false;

  beforeAll(async () => {
    clientA = createClient({ url: REDIS_URL });
    clientB = createClient({ url: REDIS_URL });
    clientA.on('error', () => undefined);
    clientB.on('error', () => undefined);
    try {
      await Promise.all([clientA.connect(), clientB.connect()]);
      available = true;
    } catch {
      available = false;
    }
  }, 15_000);

  afterAll(async () => {
    if (available) {
      clientA.destroy();
      clientB.destroy();
    }
  });

  it('two limiter INSTANCES (separate connections) share ONE window', async (ctx) => {
    if (!available) return ctx.skip();
    const a = new RedisFixedWindowLimiter(clientA);
    const b = new RedisFixedWindowLimiter(clientB);
    const key = `tm03:${randomUUID()}`;
    const rule = { max: 2, windowMs: 60_000 };
    expect(await a.hit(key, rule)).toBeNull();
    expect(await a.hit(key, rule)).toBeNull();
    // La instancia B ve el presupuesto YA consumido por A: comparten estado.
    const retryAfter = await b.hit(key, rule);
    expect(retryAfter).not.toBeNull();
    expect(retryAfter!).toBeGreaterThanOrEqual(1);
  });

  it('the window expires: after windowMs the budget resets', async (ctx) => {
    if (!available) return ctx.skip();
    const a = new RedisFixedWindowLimiter(clientA);
    const key = `tm03:${randomUUID()}`;
    const rule = { max: 1, windowMs: 300 };
    expect(await a.hit(key, rule)).toBeNull();
    expect(await a.hit(key, rule)).not.toBeNull();
    await new Promise((r) => setTimeout(r, 400));
    expect(await a.hit(key, rule)).toBeNull();
  });
});

describe('TM-03 end-to-end: DOS instancias del API comparten presupuesto de login', () => {
  let appA: FastifyInstance;
  let appB: FastifyInstance;
  let authPool: Pool;
  let appPool: Pool;
  let client: ReturnType<typeof createClient>;
  let available = false;

  beforeAll(async () => {
    client = createClient({ url: REDIS_URL });
    client.on('error', () => undefined);
    try {
      await client.connect();
      available = true;
    } catch {
      return;
    }
    const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' });
    appPool = createPool({ connectionString: config.db.app, max: 2 });
    authPool = createPool({ connectionString: config.db.auth, max: 2 });
    // Dos apps DISTINTAS (dos "instancias") con el MISMO backend Redis y un
    // prefijo único por corrida (aisla el test de corridas anteriores).
    const prefix = `tm03e2e:${randomUUID()}`;
    const mk = () =>
      buildApp({
        config,
        appPool,
        authService: new AuthService(authPool),
        rateLimiter: new RedisFixedWindowLimiter(client, { prefix }),
        authRateLimits: {
          loginPerEmail: { max: 10_000, windowMs: 60_000 },
          loginPerIp: { max: 2, windowMs: 60_000 },
          registerPerIp: { max: 10_000, windowMs: 60_000 },
          mfaPerIp: { max: 10_000, windowMs: 60_000 },
        },
      });
    appA = mk();
    appB = mk();
    await Promise.all([appA.ready(), appB.ready()]);
  }, 30_000);

  afterAll(async () => {
    if (available) {
      await Promise.all([appA.close(), appB.close()]);
      await Promise.all([appPool.end(), authPool.end()]);
    }
    try {
      client.destroy();
    } catch {
      // ya desconectado — nada que limpiar
    }
  });

  it('the third login attempt is 429 EVEN on the other instance (shared window)', async (ctx) => {
    if (!available) return ctx.skip();
    const payload = {
      email: `tm03-${randomUUID().slice(0, 8)}@test.fluvia.dev`,
      password: 'x'.repeat(12),
    };
    const l1 = await appA.inject({ method: 'POST', url: '/v1/auth/login', payload });
    const l2 = await appA.inject({ method: 'POST', url: '/v1/auth/login', payload });
    expect(l1.statusCode).toBe(401); // credenciales inválidas, pero DENTRO de presupuesto
    expect(l2.statusCode).toBe(401);
    // Tercera en la OTRA instancia: sin store compartido esto sería 401 (hueco).
    const l3 = await appB.inject({ method: 'POST', url: '/v1/auth/login', payload });
    expect(l3.statusCode).toBe(429);
    expect(l3.json().error.code).toBe('rate_limited');
    expect(Number(l3.headers['retry-after'])).toBeGreaterThanOrEqual(1);
  });
});
