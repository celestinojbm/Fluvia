import type { Pool } from '@fluvia/db';
import { redactSummary, withPlatformOperation } from '@fluvia/audit';
import type { ZodTypeAny } from 'zod';

/**
 * Procesador asincrono del inbox (F2-12) — misma familia de semantica que el
 * outbox relay (ADR-0011): claim-lease con FOR UPDATE SKIP LOCKED, backoff
 * exponencial con jitter, veneno -> dead con DLQ redactada, barrido de
 * zombies y dead -> pending SOLO via replay de plataforma auditado.
 *
 * El procesador NO contiene logica de negocio: valida el payload del provider
 * contra su schema Zod registrado y delega en el handler, que decide el
 * desenlace (applied / ignored_out_of_order / ignored). Los handlers reales
 * llegan con los adapters (F3-03); aplican efectos con servicios tenant-scoped
 * y son idempotentes (las FSM validan transiciones).
 */

export type InboxOutcome = 'applied' | 'ignored_out_of_order' | 'ignored';

export interface InboxHandlerResult {
  outcome: InboxOutcome;
  detail?: string;
}

export interface ParsedProviderEvent {
  /** id BIGINT de la fila como string. */
  id: string;
  provider: string;
  providerEventId: string;
  eventType: string | null;
  /** Payload YA validado contra el schema del provider. */
  payload: unknown;
  /** Numero de ESTE intento (1 = primero). */
  attempt: number;
}

export interface ProviderRegistration {
  /** Schema Zod del payload del provider; lo no conforme va a la DLQ. */
  schema: ZodTypeAny;
  handler(event: ParsedProviderEvent): Promise<InboxHandlerResult>;
}

export interface InboxLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface InboxProcessorOptions {
  workerId?: string;
  batchSize?: number;
  leaseMs?: number;
  maxAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  jitterRatio?: number;
  logger?: InboxLogger;
  /** F1-07: observador de metricas por ciclo. Sus errores JAMAS afectan al processor. */
  onStats?: (stats: InboxRunStats) => void;
}

export interface InboxRunStats {
  claimed: number;
  processed: number;
  ignored: number;
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

interface ClaimedRow {
  id: string;
  provider: string;
  provider_event_id: string;
  event_type: string | null;
  raw_body: string;
  attempts: number;
}

/** Igual que en el relay del outbox: base * 2^(attempt-1), acotado. */
function computeBackoffMs(
  opts: Pick<ResolvedOptions, 'baseBackoffMs' | 'maxBackoffMs'>,
  attempt: number
): number {
  return Math.min(opts.maxBackoffMs, opts.baseBackoffMs * 2 ** Math.max(0, attempt - 1));
}

export class InboxProcessor {
  private readonly opts: ResolvedOptions;
  private readonly registry = new Map<string, ProviderRegistration>();
  private readonly logger: InboxLogger | undefined;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;

  constructor(
    /** Pool con rol fluvia_inbox (privilegio minimo, patron ADR-0011). */
    private readonly inboxPool: Pool,
    options: InboxProcessorOptions = {}
  ) {
    this.opts = {
      workerId: options.workerId ?? `inbox-${process.pid}`,
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

  private readonly onStats: ((stats: InboxRunStats) => void) | undefined;

  register(provider: string, registration: ProviderRegistration): void {
    this.registry.set(provider, registration);
  }

  async runOnce(): Promise<InboxRunStats> {
    const stats: InboxRunStats = { claimed: 0, processed: 0, ignored: 0, retried: 0, dead: 0 };

    const swept = await this.inboxPool.query(
      `UPDATE provider_events
       SET status = 'dead',
           last_error = COALESCE(last_error, 'max processing attempts exhausted (lease expired)')
       WHERE status = 'pending' AND attempts >= $1 AND next_attempt_at <= now()
       RETURNING id`,
      [this.opts.maxAttempts]
    );
    stats.dead += swept.rowCount ?? 0;

    const claimed = await this.inboxPool.query<ClaimedRow>(
      `WITH eligible AS (
         SELECT id FROM provider_events
         WHERE status = 'pending' AND attempts < $1 AND next_attempt_at <= now()
         ORDER BY next_attempt_at, id
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       UPDATE provider_events p
       SET attempts = p.attempts + 1,
           next_attempt_at = now() + make_interval(secs => $3::float8 / 1000),
           locked_by = $4
       FROM eligible e
       WHERE p.id = e.id
       RETURNING p.id::text AS id, p.provider, p.provider_event_id, p.event_type,
                 p.raw_body, p.attempts`,
      [this.opts.maxAttempts, this.opts.batchSize, this.opts.leaseMs, this.opts.workerId]
    );
    stats.claimed = claimed.rowCount ?? 0;

    for (const row of claimed.rows) {
      const registration = this.registry.get(row.provider);
      if (!registration) {
        // Hueco de configuracion, no veneno: el payload puede ser valido.
        // Tras desplegar el handler se resucita con el replay auditado.
        await this.markDead(row.id, `no handler registered for provider "${row.provider}"`);
        stats.dead += 1;
        continue;
      }

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(row.raw_body);
      } catch (err) {
        await this.toDlq(row, `invalid JSON: ${String(err).slice(0, 300)}`);
        stats.dead += 1;
        continue;
      }

      const validated = registration.schema.safeParse(parsedJson);
      if (!validated.success) {
        const detail = validated.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ')
          .slice(0, 500);
        await this.toDlq(row, `schema validation failed: ${detail}`, parsedJson);
        stats.dead += 1;
        continue;
      }

      try {
        const result = await registration.handler({
          id: row.id,
          provider: row.provider,
          providerEventId: row.provider_event_id,
          eventType: row.event_type,
          payload: validated.data,
          attempt: row.attempts,
        });
        const status = result.outcome === 'applied' ? 'processed' : 'ignored';
        await this.inboxPool.query(
          `UPDATE provider_events
           SET status = $2, result = $3, processed_at = now(), last_error = NULL, locked_by = NULL
           WHERE id = $1 AND status = 'pending'`,
          [row.id, status, result.detail ? `${result.outcome}: ${result.detail}` : result.outcome]
        );
        if (status === 'processed') stats.processed += 1;
        else stats.ignored += 1;
      } catch (err) {
        const detail = String(err).slice(0, 500);
        if (row.attempts >= this.opts.maxAttempts) {
          await this.markDead(row.id, detail);
          stats.dead += 1;
          this.logger?.error(
            { providerEventId: row.provider_event_id, attempts: row.attempts },
            'provider event exhausted attempts, moved to dead'
          );
        } else {
          const backoff = this.withJitter(computeBackoffMs(this.opts, row.attempts));
          await this.inboxPool.query(
            `UPDATE provider_events
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
      this.logger?.error({ err: String(err) }, 'inbox stats observer failed (ignored)');
    }
    return stats;
  }

  start(intervalMs = 1_000): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      this.runOnce()
        .then((stats) => {
          if (stats.claimed > 0 || stats.dead > 0) {
            this.logger?.info({ ...stats }, 'inbox processor cycle');
          }
        })
        .catch((err: unknown) => {
          this.logger?.error({ err: String(err) }, 'inbox processor cycle failed');
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
    await this.inboxPool.query(
      `UPDATE provider_events
       SET status = 'dead', last_error = $2, locked_by = NULL
       WHERE id = $1 AND status = 'pending'`,
      [id, error]
    );
  }

  /** Veneno: dead + copia REDACTADA en la DLQ (jamas se descarta en silencio). */
  private async toDlq(row: ClaimedRow, error: string, parsed?: unknown): Promise<void> {
    await this.inboxPool.query(
      `INSERT INTO raw_provider_payloads_dlq (provider, payload, validation_error)
       VALUES ($1, $2, $3)`,
      [
        row.provider,
        JSON.stringify({
          provider_event_id: row.provider_event_id,
          payload:
            parsed !== undefined
              ? redactSummary(parsed)
              : { raw_truncated: row.raw_body.slice(0, 2_000) },
        }),
        error,
      ]
    );
    await this.markDead(row.id, `poison: ${error}`);
    this.logger?.error(
      { providerEventId: row.provider_event_id, provider: row.provider },
      'poison provider event moved to dead + DLQ'
    );
  }
}

export interface ReplayDeadProviderEventsOptions {
  /** ids (BIGINT como string) de provider_events en estado dead. */
  eventIds: string[];
  /** OBLIGATORIA — quien y por que reprocesa estos eventos. */
  reason: string;
  /** UUID del operador (audit_events.actor_id es UUID). */
  actorId?: string;
  requestId?: string;
}

/** dead -> pending SOLO por aqui: operacion de plataforma auditada (pool admin). */
export async function replayDeadProviderEvents(
  adminPool: Pool,
  options: ReplayDeadProviderEventsOptions
): Promise<string[]> {
  const details: { replayed_ids?: string[]; requested: number } = {
    requested: options.eventIds.length,
  };
  return withPlatformOperation(
    adminPool,
    {
      tenantId: null,
      actorId: options.actorId,
      reason: options.reason,
      requestId: options.requestId,
      resourceType: 'provider_event',
      details,
    },
    async (client) => {
      const res = await client.query<{ id: string }>(
        `UPDATE provider_events
         SET status = 'pending', attempts = 0, next_attempt_at = now(),
             last_error = NULL, locked_by = NULL, result = NULL, processed_at = NULL
         WHERE id = ANY($1::bigint[]) AND status = 'dead'
         RETURNING id::text AS id`,
        [options.eventIds]
      );
      const ids = res.rows.map((r) => r.id);
      details.replayed_ids = ids;
      return ids;
    }
  );
}
