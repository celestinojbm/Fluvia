import type { Pool } from '@fluvia/db';
import type { PayoutService } from '@fluvia/payments-core';
import type { WatchdogLogger } from './attempts-watchdog.js';

/**
 * Re-drive del plano de payouts (F4-07e). El watchdog F4-07c SURFACEA los
 * payouts `requested` cuyo `execute` (fire-and-forget del plano HTTP) nunca
 * corrio; este job los RE-CONDUCE. Es seguro por diseno: en `requested` el emit
 * aun no ocurrio, asi que el banco JAMAS fue contactado — re-ejecutar no puede
 * doble-pagar (el emit es idempotente por su key).
 *
 * La SERIALIZACION vive en `claim_stuck_payouts()` (0035): lease (updated_at) +
 * FOR UPDATE SKIP LOCKED garantizan que dos workers jamas conduzcan el mismo
 * payout a la vez (lo unico que podria doble-contactar al banco, ya que tras el
 * emit ambos llamarian a submitPayout). Este job solo reclama en el pool worker
 * (definer cross-tenant) y llama `PayoutService.execute` por cada fila —
 * secuencial (cada execute son milisegundos), con aislamiento de error por
 * payout: uno que cae no frena el lote y queda re-drivable al vencer el lease.
 */

export interface RedriveResult {
  claimed: number;
  redriven: number;
  failed: number;
}

export interface PayoutsRedriverOptions {
  /** F1-07: observador de metricas por corrida. Sus errores JAMAS afectan al job. */
  onResult?: (result: RedriveResult) => void;
  /** Tope de payouts reclamados por corrida (default 20 en la funcion SQL). */
  batchSize?: number;
}

export class PayoutsRedriver {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;

  constructor(
    /** Pool con rol fluvia_worker (EXECUTE sobre claim_stuck_payouts). */
    private readonly workerPool: Pool,
    /** Servicio de payouts sobre el appPool (RLS por tenant) para la fase 2. */
    private readonly payouts: PayoutService,
    private readonly logger?: WatchdogLogger,
    private readonly options: PayoutsRedriverOptions = {}
  ) {}

  async runOnce(): Promise<RedriveResult> {
    const claimed = await this.workerPool.query<{ id: string; tenant_id: string }>(
      'SELECT id, tenant_id FROM claim_stuck_payouts($1)',
      [this.options.batchSize ?? 20]
    );
    let redriven = 0;
    let failed = 0;
    for (const row of claimed.rows) {
      try {
        // Re-ejecuta la fase 2 del payout. Sobre una fila `requested` esto emite
        // (idempotente) y contacta al banco; el desenlace (paid/failed/
        // indeterminate) lo fija y audita el propio execute.
        await this.payouts.execute(row.tenant_id, row.id);
        redriven += 1;
      } catch (err) {
        // Fallo de infraestructura: el payout queda en `requested` con el lease
        // vencido — otra corrida lo reintenta. No frena el lote.
        failed += 1;
        this.logger?.error(
          { err: String(err), payoutId: row.id },
          're-drive of stuck requested payout failed (left in requested; lease will retry)'
        );
      }
    }
    const result: RedriveResult = { claimed: claimed.rows.length, redriven, failed };
    if (result.claimed > 0) {
      this.logger?.info(
        { ...result },
        'stuck requested payouts re-driven (execute never ran; safe — bank was never contacted)'
      );
    }
    try {
      this.options.onResult?.(result);
    } catch (err) {
      this.logger?.error({ err: String(err) }, 'redriver metrics observer failed (ignored)');
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
          this.logger?.error({ err: String(err) }, 'payouts redriver run failed');
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
