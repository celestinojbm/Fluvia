import type { Pool } from '@fluvia/db';

/**
 * Watchdog del plano de attempts (F3-04). La política ENTERA vive en la
 * función SECURITY DEFINER `sweep_payment_attempts()` (0018): lease fijo de
 * submitting (5 min), umbral de envejecimiento (30 min), auditoría atómica
 * del barrido. Este job la invoca en un intervalo y expone las métricas —
 * un attempt barrido queda `indeterminate` (desenlace desconocido), JAMÁS
 * failed por asunción (V4 §23).
 */

export interface AttemptsHealth {
  sweptToIndeterminate: number;
  indeterminateTotal: number;
  indeterminateAged: number;
}

export interface WatchdogLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface AttemptsWatchdogOptions {
  /** F1-07: observador de metricas por corrida. Sus errores JAMAS afectan al job. */
  onResult?: (health: AttemptsHealth) => void;
}

export class AttemptsWatchdog {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;

  constructor(
    /** Pool con rol fluvia_worker (EXECUTE sobre sweep_payment_attempts). */
    private readonly workerPool: Pool,
    private readonly logger?: WatchdogLogger,
    private readonly options: AttemptsWatchdogOptions = {}
  ) {}

  async runOnce(): Promise<AttemptsHealth> {
    const res = await this.workerPool.query<{ metric: string; value: string }>(
      'SELECT metric, value::text FROM sweep_payment_attempts()'
    );
    const byMetric = Object.fromEntries(res.rows.map((r) => [r.metric, Number(r.value)]));
    const health: AttemptsHealth = {
      sweptToIndeterminate: byMetric.swept_to_indeterminate ?? 0,
      indeterminateTotal: byMetric.indeterminate_total ?? 0,
      indeterminateAged: byMetric.indeterminate_aged ?? 0,
    };
    if (health.sweptToIndeterminate > 0) {
      this.logger?.error(
        { swept: health.sweptToIndeterminate },
        'attempts stuck in submitting swept to INDETERMINATE (process died mid-submission?)'
      );
    }
    if (health.indeterminateAged > 0) {
      // Alerta baseline (payment-state-machines.md §2): un indeterminado que
      // envejece exige intervencion — consulta al proveedor o conciliacion.
      this.logger?.error(
        { aged: health.indeterminateAged, total: health.indeterminateTotal },
        'AGED INDETERMINATE ATTEMPTS awaiting verified resolution — investigate'
      );
    }
    try {
      this.options.onResult?.(health);
    } catch (err) {
      this.logger?.error({ err: String(err) }, 'watchdog metrics observer failed (ignored)');
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
          this.logger?.error({ err: String(err) }, 'attempts watchdog run failed');
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
