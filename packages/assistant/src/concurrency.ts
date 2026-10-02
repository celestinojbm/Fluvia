import { randomUUID } from 'node:crypto';

/**
 * Límite de respuestas EN CURSO por titular, válido con varias réplicas de la
 * API. Cada respuesta toma un «arriendo» con caducidad (si una réplica muere a
 * mitad, el arriendo vence solo y el titular no queda bloqueado).
 *
 * Si Redis no responde, el control FALLA CERRADO: el asistente responde «no
 * disponible» antes que permitir respuestas ilimitadas (cada una tiene coste).
 */
export interface ConcurrencyGate {
  /** Devuelve un token si hay hueco; null si el titular ya está al máximo. */
  acquire(key: string, max: number, leaseMs: number): Promise<string | null>;
  release(key: string, token: string): Promise<void>;
}

export class ConcurrencyBackendError extends Error {
  constructor(cause: unknown) {
    super('concurrency backend unavailable', { cause });
    this.name = new.target.name;
  }
}

export class MemoryConcurrencyGate implements ConcurrencyGate {
  private readonly leases = new Map<string, Map<string, number>>();

  async acquire(key: string, max: number, leaseMs: number): Promise<string | null> {
    const now = Date.now();
    const set = this.leases.get(key) ?? new Map<string, number>();
    for (const [t, exp] of set) if (exp <= now) set.delete(t);
    if (set.size >= max) {
      this.leases.set(key, set);
      return null;
    }
    const token = randomUUID();
    set.set(token, now + leaseMs);
    this.leases.set(key, set);
    return token;
  }

  async release(key: string, token: string): Promise<void> {
    const set = this.leases.get(key);
    set?.delete(token);
    if (set && set.size === 0) this.leases.delete(key);
  }
}

/** Puerto mínimo del cliente Redis (node-redis v4+ lo cumple). */
export interface RedisEvalPort {
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

// ZSET por titular: miembro = token, puntuación = vencimiento (ms). Limpia los
// vencidos, cuenta y añade en un solo paso atómico.
const ACQUIRE_LUA = `
local now = tonumber(ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then return 0 end
redis.call('ZADD', KEYS[1], now + tonumber(ARGV[2]), ARGV[4])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]) * 2)
return 1
`;
const RELEASE_LUA = `return redis.call('ZREM', KEYS[1], ARGV[1])`;

export class RedisConcurrencyGate implements ConcurrencyGate {
  constructor(
    private readonly client: RedisEvalPort,
    private readonly prefix = 'fluvia:assistant:inflight'
  ) {}

  async acquire(key: string, max: number, leaseMs: number): Promise<string | null> {
    const token = randomUUID();
    let ok: unknown;
    try {
      ok = await this.client.eval(ACQUIRE_LUA, {
        keys: [`${this.prefix}:${key}`],
        arguments: [String(Date.now()), String(leaseMs), String(max), token],
      });
    } catch (err) {
      throw new ConcurrencyBackendError(err);
    }
    return Number(ok) === 1 ? token : null;
  }

  async release(key: string, token: string): Promise<void> {
    try {
      await this.client.eval(RELEASE_LUA, { keys: [`${this.prefix}:${key}`], arguments: [token] });
    } catch {
      /* el arriendo vence solo */
    }
  }
}
