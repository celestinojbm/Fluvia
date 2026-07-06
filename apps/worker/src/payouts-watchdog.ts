import type { Pool } from '@fluvia/db';

/**
 * Watchdog del plano de payouts (F4-07c). La política ENTERA vive en la función
 * SECURITY DEFINER `sweep_payouts()` (0034): lease fijo de in_transit (5 min),
 * umbral de envejecimiento (30 min), auditoría atómica del barrido. Este job la
 * invoca en un intervalo y expone las métricas — un payout barrido queda
 * `indeterminate` (desenlace del banco desconocido, fondos RETENIDOS en
 * tránsito), JAMÁS `failed` por asunción (V4 §23). La resolución sigue siendo
 * SOLO por fuente verificada (webhook del banco / consulta / conciliación).
 */

export interface PayoutsHealth {
  sweptToIndeterminate: number;
  indeterminateTotal: number;
  indeterminateAged: number;
  requestedStuck: number;
}

export interface WatchdogLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface PayoutsWatchdogOptions {
  /** F1-07: observador de métricas por corrida. Sus errores JAMÁS afectan al job. */
  onResult?: (health: PayoutsHealth) => void;
}

export class PayoutsWatchdog {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;

  constructor(
    /** Pool con rol fluvia_worker (EXECUTE sobre sweep_payouts). */
    private readonly workerPool: Pool,
    private readonly logger?: WatchdogLogger,
    private readonly options: PayoutsWatchdogOptions = {}
  ) {}

  async runOnce(): Promise<PayoutsHealth> {
    const res = await this.workerPool.query<{ metric: string; value: string }>(
      'SELECT metric, value::text FROM sweep_payouts()'
    );
    const byMetric = Object.fromEntries(res.rows.map((r) => [r.metric, Number(r.value)]));
    const health: PayoutsHealth = {
      sweptToIndeterminate: byMetric.swept_to_indeterminate ?? 0,
      indeterminateTotal: byMetric.indeterminate_total ?? 0,
      indeterminateAged: byMetric.indeterminate_aged ?? 0,
      requestedStuck: byMetric.requested_stuck ?? 0,
    };
    if (health.sweptToIndeterminate > 0) {
      this.logger?.error(
        { swept: health.sweptToIndeterminate },
        'payouts stuck in in_transit swept to INDETERMINATE (process died mid-bank-submission?)'
      );
    }
    if (health.indeterminateAged > 0) {
      // Alerta baseline (payment-state-machines.md §6): un indeterminado que
      // envejece exige intervención — consulta al banco o conciliación.
      this.logger?.error(
        { aged: health.indeterminateAged, total: health.indeterminateTotal },
        'AGED INDETERMINATE PAYOUTS awaiting verified resolution — funds held in transit, investigate'
      );
    }
    if (health.requestedStuck > 0) {
      // `requested` atascado: el emit nunca ocurrió (sin dinero en riesgo, el
      // banco jamás fue contactado). Se re-ejecuta manualmente/runbook — no aquí,
      // para no arriesgar doble envío (F4-07c-ii lo automatiza con lease).
      this.logger?.error(
        { stuck: health.requestedStuck },
        'STUCK REQUESTED PAYOUTS never executed (fire-and-forget crashed?) — safe to re-drive'
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
          this.logger?.error({ err: String(err) }, 'payouts watchdog run failed');
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
