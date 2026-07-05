import type { Pool } from '@fluvia/db';

/**
 * Verificacion programada de drift proyeccion↔ledger (F2-05, AUD-P2-004).
 *
 * Ejecuta la funcion SECURITY DEFINER `ledger_projection_drift()` (0011) —
 * ventana de SOLO LECTURA cross-tenant otorgada unicamente a fluvia_worker.
 * Cualquier fila devuelta es un incidente contable: se loggea a nivel error
 * (alerta baseline; las metricas/alertas formales llegan con F1-07) y la
 * reparacion es SIEMPRE explicita via LedgerService.rebuildProjection, jamas
 * automatica (V4 §30: nada de correcciones silenciosas).
 */

export interface ProjectionDriftRow {
  accountId: string;
  tenantId: string;
  /** null cuando la cuenta tiene asientos pero carece de fila de proyeccion. */
  projectedAvailable: string | null;
  projectedPending: string | null;
  recomputedAvailable: string;
  recomputedPending: string;
}

export interface DriftLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

interface DriftRowRaw {
  account_id: string;
  tenant_id: string;
  projected_available: string | null;
  projected_pending: string | null;
  recomputed_available: string;
  recomputed_pending: string;
}

export interface DriftWatcherOptions {
  /** F1-07: observador de metricas por chequeo. Sus errores JAMAS afectan al watcher. */
  onCheck?: (rows: ProjectionDriftRow[]) => void;
}

export class ProjectionDriftWatcher {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;

  constructor(
    /** Pool con rol fluvia_worker (EXECUTE sobre ledger_projection_drift). */
    private readonly workerPool: Pool,
    private readonly logger?: DriftLogger,
    private readonly options: DriftWatcherOptions = {}
  ) {}

  async runOnce(): Promise<ProjectionDriftRow[]> {
    const res = await this.workerPool.query<DriftRowRaw>(
      `SELECT account_id, tenant_id,
              projected_available::text, projected_pending::text,
              recomputed_available::text, recomputed_pending::text
       FROM ledger_projection_drift()`
    );
    const rows = res.rows.map((r) => ({
      accountId: r.account_id,
      tenantId: r.tenant_id,
      projectedAvailable: r.projected_available,
      projectedPending: r.projected_pending,
      recomputedAvailable: r.recomputed_available,
      recomputedPending: r.recomputed_pending,
    }));
    if (rows.length > 0) {
      this.logger?.error(
        { driftCount: rows.length, accounts: rows.map((r) => r.accountId) },
        'LEDGER PROJECTION DRIFT DETECTED — investigate before any rebuild'
      );
    }
    try {
      this.options.onCheck?.(rows);
    } catch (err) {
      this.logger?.error({ err: String(err) }, 'drift metrics observer failed (ignored)');
    }
    return rows;
  }

  start(intervalMs = 60_000): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      this.runOnce()
        .catch((err: unknown) => {
          this.logger?.error({ err: String(err) }, 'projection drift check failed');
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
