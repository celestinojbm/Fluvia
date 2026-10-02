import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createClient } from 'redis';
import { loadConfig } from '@fluvia/config';
import { createPool, type Pool } from '@fluvia/db';
import { AuthService } from '@fluvia/auth';
import { ApiKeyService, IdentityService } from '@fluvia/identity';
import {
  MemoryStorage,
  RedisConcurrencyGate,
  SimulatedCallTransport,
  SimulatedConversationProvider,
  SimulatedSpeechToText,
  SimulatedTextToSpeech,
} from '@fluvia/assistant';
import { buildApp } from '../src/app.js';
import { RedisFixedWindowLimiter } from '../src/rate-limit.js';

/**
 * Varias réplicas de la API contra el MISMO PostgreSQL y Redis:
 *  - la concurrencia de respuestas por titular se respeta ENTRE réplicas;
 *  - los límites del asistente son por titular autenticado: dos clientes que
 *    llegan desde la misma IP (la del BFF) no comparten cupo.
 */
let a: FastifyInstance;
let b: FastifyInstance;
let appPool: Pool;
let authPool: Pool;
let adminPool: Pool;
let program: string;
const redis = createClient({ url: loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' }).redisUrl });
const prefix = `t-${randomUUID().slice(0, 8)}`;

function replica(): FastifyInstance {
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    FLUVIA_PROGRAM_TENANT_ID: program,
  });
  return buildApp({
    config,
    appPool,
    authPool,
    authService: new AuthService(authPool),
    identityService: new IdentityService(appPool),
    apiKeyService: new ApiKeyService(appPool),
    rateLimiter: new RedisFixedWindowLimiter(redis, { prefix: `${prefix}:rl` }),
    authRateLimits: {
      loginPerEmail: { max: 10_000, windowMs: 60_000 },
      loginPerIp: { max: 10_000, windowMs: 60_000 },
      registerPerIp: { max: 10_000, windowMs: 60_000 },
      mfaPerIp: { max: 10_000, windowMs: 60_000 },
    },
    assistant: {
      env: { ASSISTANT_REQUESTS_PER_MINUTE: '8' },
      storage: new MemoryStorage(),
      concurrency: new RedisConcurrencyGate(redis, `${prefix}:inflight`),
      providers: {
        conversation: new SimulatedConversationProvider(120),
        stt: new SimulatedSpeechToText(),
        tts: new SimulatedTextToSpeech(),
        call: new SimulatedCallTransport(),
      },
    },
  });
}

beforeAll(async () => {
  await redis.connect();
  const base = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' });
  adminPool = createPool({ connectionString: base.db.admin, max: 2 });
  appPool = createPool({ connectionString: base.db.app, max: 8 });
  authPool = createPool({ connectionString: base.db.auth, max: 4 });
  const r = await adminPool.query<{ id: string }>(
    'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id',
    ['Programa réplicas', `org-${randomUUID()}`]
  );
  program = r.rows[0]!.id;
  a = replica();
  b = replica();
  await Promise.all([a.ready(), b.ready()]);
  // Programa mínimo para registrar clientes.
  await adminPool.query(
    `INSERT INTO consumer_programs (tenant_id, name, currencies) VALUES ($1, 'Fluvia Personal', '{VES}')`,
    [program]
  );
}, 60_000);

afterAll(async () => {
  await Promise.all([a.close(), b.close()]);
  await Promise.all([appPool.end(), authPool.end(), adminPool.end()]);
  await redis.quit();
});

async function consumer(app: FastifyInstance) {
  const r = await app.inject({
    method: 'POST',
    url: `/v1/personal/programs/${program}/register`,
    payload: {
      email: `rep-${randomUUID().slice(0, 10)}@personal.fluvia.test`,
      password: 'clave del cliente 2026',
      display_name: 'Réplica',
      synthetic_risk_profile: 'B',
    },
  });
  expect(r.statusCode).toBe(201);
  return { authorization: `Bearer ${r.json().session as string}` };
}

describe('concurrencia entre réplicas (Redis)', () => {
  it('mientras la réplica A responde, la réplica B rechaza al MISMO titular (409)', async () => {
    const h = await consumer(a);
    const conv = (
      await a.inject({
        method: 'POST',
        url: '/v1/personal/assistant/conversations',
        headers: h,
        payload: {},
      })
    ).json().id as string;
    const address = await a.listen({ port: 0, host: '127.0.0.1' });
    const ac = new AbortController();
    const res = await fetch(`${address}/v1/personal/assistant/conversations/${conv}/messages`, {
      method: 'POST',
      headers: { ...h, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'cuéntame qué puedes hacer' }),
      signal: ac.signal,
    });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let seen = '';
    while (!seen.includes('event: delta')) seen += dec.decode((await reader.read()).value);

    const busy = await b.inject({
      method: 'POST',
      url: `/v1/personal/assistant/conversations/${conv}/messages`,
      headers: h,
      payload: { text: 'otra pregunta' },
    });
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error.code).toBe('assistant_busy');

    // Otro titular no está afectado.
    const other = await consumer(b);
    const conv2 = (
      await b.inject({
        method: 'POST',
        url: '/v1/personal/assistant/conversations',
        headers: other,
        payload: {},
      })
    ).json().id as string;
    const ok = await b.inject({
      method: 'POST',
      url: `/v1/personal/assistant/conversations/${conv2}/messages`,
      headers: other,
      payload: { text: 'hola' },
    });
    expect(ok.statusCode).toBe(200);

    // Al terminar A, el arriendo se libera y B atiende al primer titular.
    while (!(await reader.read()).done) {
      /* consumir hasta el final */
    }
    const after = await b.inject({
      method: 'POST',
      url: `/v1/personal/assistant/conversations/${conv}/messages`,
      headers: h,
      payload: { text: 'ahora sí' },
    });
    expect(after.statusCode).toBe(200);
  }, 30_000);
});

describe('límites por titular autenticado (no por IP del BFF)', () => {
  it('agotar el cupo de un cliente no limita a otro que llega desde la misma IP', async () => {
    const one = await consumer(a);
    const two = await consumer(a);
    for (let i = 0; i < 8; i++) {
      expect(
        (await a.inject({ method: 'GET', url: '/v1/personal/assistant/status', headers: one }))
          .statusCode
      ).toBe(200);
    }
    const blocked = await b.inject({
      method: 'GET',
      url: '/v1/personal/assistant/status',
      headers: one,
    });
    expect(blocked.statusCode).toBe(429);
    const free = await b.inject({
      method: 'GET',
      url: '/v1/personal/assistant/status',
      headers: two,
    });
    expect(free.statusCode).toBe(200);
  });
});
