import type { Pool } from '@fluvia/db';
import { parseEnvelope, type EventEnvelope } from '@fluvia/events';

/**
 * Outbox Relay (F2-11, ADR-0007/ADR-0011).
 *
 * Semantica de despacho:
 *  - Claim atomico por lotes con FOR UPDATE SKIP LOCKED: dos relays jamas
 *    toman la misma fila (CA: sin doble entrega con 2 workers).
 *  - El claim ES el lease: incrementa attempts y empuja next_attempt_at
 *    (now + lease). La publicacion ocurre FUERA de la transaccion (Nivel A:
 *    nada de llamadas externas dentro de una transaccion SQL). Si el proceso
 *    muere tras el claim, el lease expira y la fila vuelve a ser elegible.
 *  - Fallo => backoff exponencial con jitter; attempts agotados => dead (DLQ
 *    in situ via status, la tabla no se borra jamas).
 *  - Payload que no valida el envelope comun => veneno: dead inmediato SIN
 *    llamar al publisher.
 *  - dead solo vuelve a pending via replay AUDITADO (replay.ts).
 *
 * Entrega efectiva: at-least-once. El publisher puede completar y el proceso
 * morir antes de marcar delivered => reintento. Los consumidores deduplican
 * por event_id (inbox F2-12 / webhooks F3-07).
 */

export interface ClaimedOutboxEvent {
  /** id BIGINT de la fila como string. */
  id: string;
  tenantId: string;
  topic: string;
  envelope: EventEnvelope;
  /** Numero de ESTE intento (1 = primero). */
  attempt: number;
}

export interface OutboxPublisher {
  /** Lanzar = fallo del intento (backoff/dead). Resolver = entregado. */
  publish(event: ClaimedOutboxEvent): Promise<void>;
}

export interface RelayLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface OutboxRelayOptions {
  /** Identifica este proceso en locked_by (observabilidad). */
  workerId?: string;
  batchSize?: number;
  /** Duracion del lease del claim; un crash re-elige la fila al expirar. */
  leaseMs?: number;
  /** Intentos totales antes de dead. */
  maxAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** Jitter multiplicativo +/- ratio (0.2 => 80%..120% del backoff). */
  jitterRatio?: number;
  logger?: RelayLogger;
  /** F1-07: observador de metricas por ciclo. Sus errores JAMAS afectan al relay. */
  onStats?: (stats: RelayRunStats) => void;
}

export interface RelayRunStats {
  claimed: number;
  delivered: number;
  retried: number;
  dead: number;
}

interface ResolvedOptions {
  workerId: string;
  batchSize: number;
  leaseMs: number;
  maxAttempts: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  jitterRatio: number;
}

/** Backoff exponencial determinista (sin jitter): base * 2^(attempt-1), acotado. */
export function computeBackoffMs(
  opts: Pick<ResolvedOptions, 'baseBackoffMs' | 'maxBackoffMs'>,
  attempt: number
): number {
  const exp = opts.baseBackoffMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(opts.maxBackoffMs, exp);
}

interface ClaimedRow {
  id: string;
  tenant_id: string;
  topic: string;
  payload: unknown;
  attempts: number;
}

export class OutboxRelay {
  private readonly opts: ResolvedOptions;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;

  constructor(
    /** Pool con rol fluvia_relay (privilegio minimo, ADR-0011). */
    private readonly relayPool: Pool,
    private readonly publisher: OutboxPublisher,
    options: OutboxRelayOptions = {}
  ) {
    this.opts = {
      workerId: options.workerId ?? `relay-${process.pid}`,
      batchSize: options.batchSize ?? 25,
      leaseMs: options.leaseMs ?? 30_000,
      maxAttempts: options.maxAttempts ?? 8,
      baseBackoffMs: options.baseBackoffMs ?? 1_000,
      maxBackoffMs: options.maxBackoffMs ?? 300_000,
      jitterRatio: options.jitterRatio ?? 0.2,
    };
    this.logger = options.logger;
    this.onStats = options.onStats;
  }

  private readonly logger: RelayLogger | undefined;
  private readonly onStats: ((stats: RelayRunStats) => void) | undefined;

  /**
   * Un ciclo completo: barrido de zombies -> claim -> publicar -> marcar.
   * Idempotente y seguro de correr en paralelo desde N procesos.
   */
  async runOnce(): Promise<RelayRunStats> {
    const stats: RelayRunStats = { claimed: 0, delivered: 0, retried: 0, dead: 0 };

    // Zombies: filas cuyo lease expiro con attempts ya agotados (proceso que
    // murio tras el ultimo claim). Sin este barrido quedarian pending para
    // siempre porque el claim exige attempts < max.
    const swept = await this.relayPool.query(
      `UPDATE outbox_events
       SET status = 'dead',
           last_error = COALESCE(last_error, 'max delivery attempts exhausted (lease expired)')
       WHERE status = 'pending' AND attempts >= $1 AND next_attempt_at <= now()
       RETURNING id`,
      [this.opts.maxAttempts]
    );
    stats.dead += swept.rowCount ?? 0;

    const claimed = await this.relayPool.query<ClaimedRow>(
      `WITH eligible AS (
         SELECT id FROM outbox_events
         WHERE status = 'pending' AND attempts < $1 AND next_attempt_at <= now()
         ORDER BY next_attempt_at, id
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       UPDATE outbox_events o
       SET attempts = o.attempts + 1,
           next_attempt_at = now() + make_interval(secs => $3::float8 / 1000),
           locked_by = $4
       FROM eligible e
       WHERE o.id = e.id
       RETURNING o.id::text AS id, o.tenant_id, o.topic, o.payload, o.attempts`,
      [this.opts.maxAttempts, this.opts.batchSize, this.opts.leaseMs, this.opts.workerId]
    );
    stats.claimed = claimed.rowCount ?? 0;

    for (const row of claimed.rows) {
      let envelope: EventEnvelope;
      try {
        envelope = parseEnvelope(row.payload);
      } catch (err) {
        // Veneno: jamas se reintenta un payload estructuralmente invalido.
        await this.markDead(row.id, `poison: ${String(err)}`);
        stats.dead += 1;
        this.logger?.error({ outboxId: row.id, topic: row.topic }, 'poison event moved to dead');
        continue;
      }

      try {
        await this.publisher.publish({
          id: row.id,
          tenantId: row.tenant_id,
          topic: row.topic,
          envelope,
          attempt: row.attempts,
        });
        await this.relayPool.query(
          `UPDATE outbox_events
           SET status = 'delivered', delivered_at = now(), last_error = NULL, locked_by = NULL
           WHERE id = $1 AND status = 'pending'`,
          [row.id]
        );
        stats.delivered += 1;
      } catch (err) {
        const detail = String(err).slice(0, 500);
        if (row.attempts >= this.opts.maxAttempts) {
          await this.markDead(row.id, detail);
          stats.dead += 1;
          this.logger?.error(
            { outboxId: row.id, topic: row.topic, attempts: row.attempts },
            'event exhausted attempts, moved to dead'
          );
        } else {
          const backoff = this.withJitter(computeBackoffMs(this.opts, row.attempts));
          await this.relayPool.query(
            `UPDATE outbox_events
             SET next_attempt_at = now() + make_interval(secs => $2::float8 / 1000),
                 last_error = $3, locked_by = NULL
             WHERE id = $1 AND status = 'pending'`,
            [row.id, backoff, detail]
          );
          stats.retried += 1;
        }
      }
    }
    try {
      this.onStats?.(stats);
    } catch (err) {
      this.logger?.error({ err: String(err) }, 'relay stats observer failed (ignored)');
    }
    return stats;
  }

  /** Loop periodico sin solapamiento (si un ciclo sigue vivo, se salta el tick). */
  start(intervalMs = 1_000): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      this.runOnce()
        .then((stats) => {
          if (stats.claimed > 0 || stats.dead > 0) {
            this.logger?.info({ ...stats }, 'outbox relay cycle');
          }
        })
        .catch((err: unknown) => {
          this.logger?.error({ err: String(err) }, 'outbox relay cycle failed');
        })
        .finally(() => {
          this.running = false;
        });
    }, intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private withJitter(ms: number): number {
    const delta = ms * this.opts.jitterRatio;
    return Math.max(0, Math.round(ms - delta + Math.random() * 2 * delta));
  }

  private async markDead(id: string, error: string): Promise<void> {
    await this.relayPool.query(
      `UPDATE outbox_events
       SET status = 'dead', last_error = $2, locked_by = NULL
       WHERE id = $1 AND status = 'pending'`,
      [id, error]
    );
  }
}

/** Publisher de sandbox: log estructurado. La entrega real llega con F3-07/F2-12. */
export function createLogPublisher(logger: RelayLogger): OutboxPublisher {
  return {
    async publish(event) {
      logger.info(
        {
          outboxId: event.id,
          topic: event.topic,
          eventId: event.envelope.event_id,
          tenantId: event.tenantId,
          attempt: event.attempt,
        },
        'outbox event dispatched (log sink)'
      );
    },
  };
}
