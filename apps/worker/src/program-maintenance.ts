import type { Pool } from '@fluvia/db';
import type { UncertainPaymentResolver } from '@fluvia/payments-core';
import type { PersonalServices } from '@fluvia/personal';
import type { WatchdogLogger } from './attempts-watchdog.js';

/**
 * Mantenimiento del programa de consumo y de los inciertos del comercio
 * (jornada integral). Cada corrida, por FUENTE VERIFICADA y nunca por
 * suposición:
 *  - programas: retiros inciertos ⇒ consulta al proveedor de fondeo; eventos
 *    sin objeto ⇒ reintento controlado; autorizaciones vencidas ⇒ liberación
 *    de reservas; cuotas vencidas ⇒ marcado con fecha de corte (política).
 *  - comercios: cobros/devoluciones inciertos ⇒ `queryPayment`/`queryRefund`.
 * El pool worker solo LISTA tenants (funciones definer de 0053); el trabajo lo
 * hace el rol de la app con contexto de tenant. Aislamiento de error por
 * tenant: uno que falla no frena el resto.
 */
export interface ProgramMaintenanceResult {
  programs: number;
  withdrawalsResolved: number;
  eventsApplied: number;
  authorizationsExpired: number;
  installmentsMarkedOverdue: number;
  merchantTenants: number;
  paymentsResolved: number;
  refundsResolved: number;
  failures: number;
}

export interface ProgramMaintenanceOptions {
  onResult?: (r: ProgramMaintenanceResult) => void;
  /** Antigüedad mínima de un incierto del comercio antes de consultarlo. */
  minUncertainAgeSeconds?: number;
  now?: () => Date;
}

export class ProgramMaintenanceJob {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;

  constructor(
    private readonly workerPool: Pool,
    private readonly personal: PersonalServices,
    private readonly merchantResolver: UncertainPaymentResolver,
    private readonly logger?: WatchdogLogger,
    private readonly options: ProgramMaintenanceOptions = {}
  ) {}

  async runOnce(): Promise<ProgramMaintenanceResult> {
    const now = this.options.now?.() ?? new Date();
    const r: ProgramMaintenanceResult = {
      programs: 0,
      withdrawalsResolved: 0,
      eventsApplied: 0,
      authorizationsExpired: 0,
      installmentsMarkedOverdue: 0,
      merchantTenants: 0,
      paymentsResolved: 0,
      refundsResolved: 0,
      failures: 0,
    };
    const programs = await this.workerPool.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM list_program_tenants()'
    );
    for (const { tenant_id } of programs.rows) {
      r.programs += 1;
      try {
        r.withdrawalsResolved += (
          await this.personal.wallet.resolveUncertainWithdrawals(tenant_id)
        ).resolved;
        r.eventsApplied += (await this.personal.events.retryUnmatched(tenant_id)).applied;
        r.authorizationsExpired += (
          await this.personal.authorizations.expireStale(tenant_id, now)
        ).expired;
        r.installmentsMarkedOverdue += (
          await this.personal.credit.markOverdue(tenant_id, now)
        ).marked;
      } catch (err) {
        r.failures += 1;
        this.logger?.error(
          { err: String(err), tenantId: tenant_id },
          'program maintenance failed for tenant'
        );
      }
    }
    const merchants = await this.workerPool.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM list_tenants_with_uncertain_payments($1)',
      [this.options.minUncertainAgeSeconds ?? 60]
    );
    for (const { tenant_id } of merchants.rows) {
      r.merchantTenants += 1;
      try {
        const out = await this.merchantResolver.resolveTenant(tenant_id);
        r.paymentsResolved += out.attempts.resolved;
        r.refundsResolved += out.refunds.resolved;
      } catch (err) {
        r.failures += 1;
        this.logger?.error(
          { err: String(err), tenantId: tenant_id },
          'uncertain payment resolution failed'
        );
      }
    }
    if (r.withdrawalsResolved + r.eventsApplied + r.paymentsResolved + r.refundsResolved > 0) {
      this.logger?.info(
        { ...r },
        'program maintenance resolved uncertain items by verified source'
      );
    }
    try {
      this.options.onResult?.(r);
    } catch (err) {
      this.logger?.error({ err: String(err) }, 'program maintenance observer failed (ignored)');
    }
    return r;
  }

  start(intervalMs = 60_000): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      this.runOnce()
        .catch((err: unknown) => {
          this.logger?.error({ err: String(err) }, 'program maintenance run failed');
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
