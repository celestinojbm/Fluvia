import type { Pool } from '@fluvia/db';

/**
 * Job de purga de datos técnicos (F1-09, decisión #14).
 *
 * TODA la política vive en la función SECURITY DEFINER `purge_technical_data()`
 * (migración 0015): predicados fijos, clases técnicas únicamente, auditoría
 * atómica en la misma transacción. Este job solo la invoca en un intervalo y
 * expone el resultado a logs/métricas — no puede ensanchar el alcance porque
 * la función no acepta parámetros y el rol worker no tiene DELETE en ninguna
 * tabla.
 */

export interface PurgeResultRow {
  class: string;
  purged: number;
}

export interface PurgeLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface PurgeJobOptions {
  /** F1-07: observador de metricas por corrida. Sus errores JAMAS afectan al job. */
  onResult?: (rows: PurgeResultRow[]) => void;
}

export class TechnicalPurgeJob {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;

  constructor(
    /** Pool con rol fluvia_worker (EXECUTE sobre purge_technical_data). */
    private readonly workerPool: Pool,
    private readonly logger?: PurgeLogger,
    private readonly options: PurgeJobOptions = {}
  ) {}

  async runOnce(): Promise<PurgeResultRow[]> {
    const res = await this.workerPool.query<{ class: string; purged: string }>(
      'SELECT class, purged::text FROM purge_technical_data()'
    );
    const rows = res.rows.map((r) => ({ class: r.class, purged: Number(r.purged) }));
    const total = rows.reduce((sum, r) => sum + r.purged, 0);
    if (total > 0) {
      this.logger?.info(
        { total, byClass: Object.fromEntries(rows.map((r) => [r.class, r.purged])) },
        'technical data purged (audited in-transaction)'
      );
    }
    try {
      this.options.onResult?.(rows);
    } catch (err) {
      this.logger?.error({ err: String(err) }, 'purge metrics observer failed (ignored)');
    }
    return rows;
  }

  start(intervalMs = 3_600_000): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      this.runOnce()
        .catch((err: unknown) => {
          this.logger?.error({ err: String(err) }, 'technical purge run failed');
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
