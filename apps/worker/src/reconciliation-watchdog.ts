import type { Pool } from '@fluvia/db';
import type { WatchdogLogger } from './attempts-watchdog.js';

/**
 * Watchdog de conciliación (F4-02): lleva la conciliación de "a demanda"
 * (F4-01b) a "continua". Invoca `sweep_settlement_reports()` (0028) en un
 * intervalo: concilia automáticamente los reportes cuyo periodo ya cerró
 * (`open` + `period_end <= now()`) y expone las métricas por resultado.
 *
 * TODA la política vive en la función SECURITY DEFINER (clasificación idéntica
 * al motor per-tenant, lease vía FOR UPDATE SKIP LOCKED, marca atómica). Este
 * job solo la invoca y ALERTA ante discrepancias — cualquier entry que no sea
 * `matched` es dinero real sin cuadrar y exige intervención (recon-baseline).
 */

export interface ReconciliationSweepResult {
  reportsReconciled: number;
  matched: number;
  amountMismatch: number;
  missingInLedger: number;
  missingAtProvider: number;
}

/** Total de entries que NO cuadran: la señal de alerta. */
export function discrepancyCount(r: ReconciliationSweepResult): number {
  return r.amountMismatch + r.missingInLedger + r.missingAtProvider;
}

export interface ReconciliationWatchdogOptions {
  /** F1-07: observador de metricas por corrida. Sus errores JAMAS afectan al job. */
  onResult?: (result: ReconciliationSweepResult) => void;
}

export class ReconciliationWatchdog {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;

  constructor(
    /** Pool con rol fluvia_worker (EXECUTE sobre sweep_settlement_reports). */
    private readonly workerPool: Pool,
    private readonly logger?: WatchdogLogger,
    private readonly options: ReconciliationWatchdogOptions = {}
  ) {}

  async runOnce(): Promise<ReconciliationSweepResult> {
    const res = await this.workerPool.query<{ metric: string; value: string }>(
      'SELECT metric, value::text FROM sweep_settlement_reports()'
    );
    const byMetric = Object.fromEntries(res.rows.map((r) => [r.metric, Number(r.value)]));
    const result: ReconciliationSweepResult = {
      reportsReconciled: byMetric.reports_reconciled ?? 0,
      matched: byMetric.matched ?? 0,
      amountMismatch: byMetric.amount_mismatch ?? 0,
      missingInLedger: byMetric.missing_in_ledger ?? 0,
      missingAtProvider: byMetric.missing_at_provider ?? 0,
    };
    if (result.reportsReconciled > 0) {
      this.logger?.info({ ...result }, 'settlement reports reconciled by watchdog (period sealed)');
    }
    const discrepancies = discrepancyCount(result);
    if (discrepancies > 0) {
      // Alerta baseline: dinero real sin cuadrar (montos discrepantes, cobros
      // que Fluvia no ve, o liquidaciones que el proveedor no reporta).
      this.logger?.error(
        {
          discrepancies,
          amountMismatch: result.amountMismatch,
          missingInLedger: result.missingInLedger,
          missingAtProvider: result.missingAtProvider,
        },
        'RECONCILIATION DISCREPANCIES detected — real money unaccounted for, investigate'
      );
    }
    try {
      this.options.onResult?.(result);
    } catch (err) {
      this.logger?.error(
        { err: String(err) },
        'reconciliation watchdog metrics observer failed (ignored)'
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
          this.logger?.error({ err: String(err) }, 'reconciliation watchdog run failed');
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
