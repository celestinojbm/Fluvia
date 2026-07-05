import type { Pool } from '@fluvia/db';
import type { WatchdogLogger } from './attempts-watchdog.js';

/**
 * Watchdog de sesiones de checkout (F3-05c-ii): entrega garantizada. La página
 * alojada sincroniza al consultar (F3-05c-i), pero si el comprador cierra la
 * pestaña tras pagar, la sesión quedaría `open`. Este job invoca
 * `sweep_checkout_sessions()` (0024) en un intervalo: completa las sesiones
 * cuyo intent tuvo éxito y expira las vencidas, emitiendo sus eventos
 * `checkout_session.*`. Idempotente con la sincronización perezosa (ambas
 * transicionan bajo el guard `status='open'`).
 */

export interface CheckoutSweepResult {
  completed: number;
  expired: number;
}

export interface CheckoutSessionWatchdogOptions {
  /** F1-07: observador de metricas por corrida. Sus errores JAMAS afectan al job. */
  onResult?: (result: CheckoutSweepResult) => void;
}

export class CheckoutSessionWatchdog {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;

  constructor(
    /** Pool con rol fluvia_worker (EXECUTE sobre sweep_checkout_sessions). */
    private readonly workerPool: Pool,
    private readonly logger?: WatchdogLogger,
    private readonly options: CheckoutSessionWatchdogOptions = {}
  ) {}

  async runOnce(): Promise<CheckoutSweepResult> {
    const res = await this.workerPool.query<{ metric: string; value: string }>(
      'SELECT metric, value::text FROM sweep_checkout_sessions()'
    );
    const byMetric = Object.fromEntries(res.rows.map((r) => [r.metric, Number(r.value)]));
    const result: CheckoutSweepResult = {
      completed: byMetric.completed ?? 0,
      expired: byMetric.expired ?? 0,
    };
    if (result.completed > 0 || result.expired > 0) {
      this.logger?.info({ ...result }, 'checkout sessions swept (completed/expired by watchdog)');
    }
    try {
      this.options.onResult?.(result);
    } catch (err) {
      this.logger?.error(
        { err: String(err) },
        'checkout watchdog metrics observer failed (ignored)'
      );
    }
    return result;
  }

  start(intervalMs = 60_000): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      this.runOnce()
        .catch((err: unknown) => {
          this.logger?.error({ err: String(err) }, 'checkout watchdog run failed');
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
