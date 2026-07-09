import type { FastifyReply, FastifyRequest } from 'fastify';
import { RateLimitedError } from '@fluvia/auth';

/**
 * F1-04b + TM-03 — Rate limiting por IP/email/ruta (AUD-P1-006).
 *
 * Dos backends detras de la MISMA interfaz `RateLimiter`:
 *  - `FixedWindowLimiter` (memoria de proceso): el default; suficiente y
 *    honesto para el sandbox mono-instancia.
 *  - `RedisFixedWindowLimiter` (TM-03, ADR-0002): ventana fija COMPARTIDA
 *    entre instancias via INCR+PEXPIRE atomicos (script Lua). Requerido ANTES
 *    del sandbox compartido (PEND-006): sin store compartido, N instancias
 *    multiplican el presupuesto de fuerza bruta por N.
 *
 * Postura de fallo del backend Redis: FAIL-OPEN con log de error. Es un
 * control de abuso, no una invariante financiera (el lockout por cuenta y el
 * dinero viven en Postgres): una caida de Redis no debe tumbar el login. El
 * fallo queda visible (log de error por hit) para alertar la degradacion.
 */

export interface RateRule {
  max: number;
  windowMs: number;
}

/** Interfaz comun de ambos backends; el preHandler `rateLimit` la consume. */
export interface RateLimiter {
  /** Consume 1 del bucket; segundos de espera si se excede, null si pasa. */
  hit(key: string, rule: RateRule): Promise<number | null> | number | null;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export class FixedWindowLimiter implements RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private sweepAt = 0;

  /** Consume 1 del bucket; devuelve segundos de espera si se excede. */
  hit(key: string, rule: RateRule, nowMs = Date.now()): number | null {
    this.sweep(nowMs);
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= nowMs) {
      this.buckets.set(key, { count: 1, resetAt: nowMs + rule.windowMs });
      return null;
    }
    bucket.count += 1;
    if (bucket.count > rule.max) {
      return Math.max(1, Math.ceil((bucket.resetAt - nowMs) / 1000));
    }
    return null;
  }

  /** Poda perezosa: evita crecer sin limite sin necesidad de timers. */
  private sweep(nowMs: number): void {
    if (nowMs < this.sweepAt) return;
    this.sweepAt = nowMs + 60_000;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= nowMs) this.buckets.delete(key);
    }
  }
}

/**
 * Puerto MINIMO del cliente Redis (node-redis v4+ lo satisface): el limiter no
 * se acopla al resto del API del cliente y los tests pueden inyectar un stub.
 */
export interface RedisEvalClient {
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

/**
 * Ventana fija ATOMICA en Redis: INCR + PEXPIRE en un solo script (sin carrera
 * INCR/EXPIRE — si el proceso muere entre ambos, la clave no queda eterna).
 * Devuelve el PTTL en ms cuando se excede, -1 cuando pasa. El PTTL negativo
 * (clave sin TTL por una carrera historica) se repara re-expirando.
 */
const FIXED_WINDOW_LUA = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
if c > tonumber(ARGV[2]) then
  local ttl = redis.call('PTTL', KEYS[1])
  if ttl < 0 then
    redis.call('PEXPIRE', KEYS[1], ARGV[1])
    ttl = tonumber(ARGV[1])
  end
  return ttl
end
return -1
`;

export class RedisFixedWindowLimiter implements RateLimiter {
  constructor(
    private readonly client: RedisEvalClient,
    private readonly options: {
      /** Prefijo de namespace de las claves (default 'fluvia:rl'). */
      prefix?: string;
      /** Observador de fallos del backend (el limiter FALLA ABIERTO). */
      onError?: (err: unknown) => void;
    } = {}
  ) {}

  async hit(key: string, rule: RateRule): Promise<number | null> {
    try {
      const ttlMs = (await this.client.eval(FIXED_WINDOW_LUA, {
        keys: [`${this.options.prefix ?? 'fluvia:rl'}:${key}`],
        arguments: [String(rule.windowMs), String(rule.max)],
      })) as number;
      if (typeof ttlMs !== 'number' || ttlMs < 0) return null;
      return Math.max(1, Math.ceil(ttlMs / 1000));
    } catch (err) {
      // FAIL-OPEN: control de abuso, no invariante — pero jamas en silencio.
      this.options.onError?.(err);
      return null;
    }
  }
}

export interface RateLimitCheck {
  /** null => la request no aplica a esta regla (p.ej. body sin email). */
  keyOf(req: FastifyRequest): string | null;
  rule: RateRule;
}

/**
 * preHandler Fastify: aplica un conjunto de reglas; al exceder cualquiera
 * responde 429 `rate_limited` (catalogo) con Retry-After.
 */
export function rateLimit(limiter: RateLimiter, checks: RateLimitCheck[]) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    for (const check of checks) {
      const key = check.keyOf(req);
      if (key === null) continue;
      const retryAfter = await limiter.hit(key, check.rule);
      if (retryAfter !== null) {
        reply.header('retry-after', String(retryAfter));
        req.log.warn({ bucket: key }, 'rate limit exceeded');
        throw new RateLimitedError(retryAfter);
      }
    }
  };
}

/** Extrae un email del body para limitar por cuenta objetivo (ademas de IP). */
export function emailKey(prefix: string) {
  return (req: FastifyRequest): string | null => {
    const email = (req.body as { email?: unknown } | null)?.email;
    return typeof email === 'string' ? `${prefix}:${email.trim().toLowerCase()}` : null;
  };
}

export function ipKey(prefix: string) {
  return (req: FastifyRequest): string => `${prefix}:${req.ip}`;
}
