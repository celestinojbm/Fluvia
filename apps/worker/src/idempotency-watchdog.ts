import type { Pool } from '@fluvia/db';
import type { WatchdogLogger } from './attempts-watchdog.js';

/**
 * Watchdog de la capa de idempotencia (F6, threat model §5). Espeja al de
 * disputas (F4-10): la política ENTERA vive en `sweep_idempotency_orphans()`
 * (0041), que SOLO SURFACEA la salud — un `in_progress` COMMITEADO es un
 * huérfano (o una operación multi-paso externa atascada); NADA se transiciona
 * aquí (borrarlo automáticamente arriesgaría doble ejecución, V4 §23). El job
 * invoca la función en un intervalo, expone los gauges y ALERTA ante huérfanos
 * envejecidos — que bloquean su (tenant, endpoint, key) hasta la purga.
 */

export interface IdempotencyHealth {
  inProgressTotal: number;
  inProgressAged: number;
}

export interface IdempotencyWatchdogOptions {
  /** F1-07: observador de métricas por corrida. Sus errores JAMAS afectan al job. */
  onResult?: (health: IdempotencyHealth) => void;
}

export class IdempotencyWatchdog {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;

  constructor(
    /** Pool con rol fluvia_worker (EXECUTE sobre sweep_idempotency_orphans). */
    private readonly workerPool: Pool,
    private readonly logger?: WatchdogLogger,
    private readonly options: IdempotencyWatchdogOptions = {}
  ) {}

  async runOnce(): Promise<IdempotencyHealth> {
    const res = await this.workerPool.query<{ metric: string; value: string }>(
      'SELECT metric, value::text FROM sweep_idempotency_orphans()'
    );
    const byMetric = Object.fromEntries(res.rows.map((r) => [r.metric, Number(r.value)]));
    const health: IdempotencyHealth = {
      inProgressTotal: byMetric.in_progress_total ?? 0,
      inProgressAged: byMetric.in_progress_aged ?? 0,
    };
    if (health.inProgressAged > 0) {
      // Alerta baseline: un `in_progress` envejecido nunca debería existir en
      // esta capa (claim+efecto commitean juntos). Su presencia = huérfano de
      // un flujo multi-paso o un bug; bloquea la key hasta la purga. Exige
      // investigación (no se resuelve solo — podría ser una op externa viva).
      this.logger?.error(
        { aged: health.inProgressAged, total: health.inProgressTotal },
        'AGED in_progress idempotency keys — orphaned claims blocking their (tenant, endpoint, key) until purge; investigate'
      );
    }
    try {
      this.options.onResult?.(health);
    } catch (err) {
      this.logger?.error(
        { err: String(err) },
        'idempotency watchdog metrics observer failed (ignored)'
      );
    }
    return health;
  }

  start(intervalMs = 60_000): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      this.runOnce()
        .catch((err: unknown) => {
          this.logger?.error({ err: String(err) }, 'idempotency watchdog run failed');
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
}
