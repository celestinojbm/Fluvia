import type { FastifyReply, FastifyRequest } from 'fastify';
import { RateLimitedError } from '@fluvia/auth';

/**
 * F1-04b — Rate limiting por IP/email/ruta (AUD-P1-006).
 *
 * Ventana fija en memoria de proceso: suficiente y honesto para el sandbox
 * mono-instancia (mismo enfoque que el default de fastify-rate-limit).
 * NIVEL C DOCUMENTADO: con multiples instancias el estado debe moverse a un
 * store compartido (Redis como acelerador, ADR-0002) ANTES de exponer el
 * sandbox compartido — registrado en PEND-006/production gates. Perder el
 * estado (restart) solo relaja el limite temporalmente: es un control de
 * abuso, no una invariante financiera.
 */

export interface RateRule {
  max: number;
  windowMs: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export class FixedWindowLimiter {
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

export interface RateLimitCheck {
  /** null => la request no aplica a esta regla (p.ej. body sin email). */
  keyOf(req: FastifyRequest): string | null;
  rule: RateRule;
}

/**
 * preHandler Fastify: aplica un conjunto de reglas; al exceder cualquiera
 * responde 429 `rate_limited` (catalogo) con Retry-After.
 */
export function rateLimit(limiter: FixedWindowLimiter, checks: RateLimitCheck[]) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    for (const check of checks) {
      const key = check.keyOf(req);
      if (key === null) continue;
      const retryAfter = limiter.hit(key, check.rule);
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
