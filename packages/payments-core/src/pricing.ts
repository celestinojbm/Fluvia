import { Money } from '@fluvia/money';

/**
 * Motor de fees (F4-05c, cierra PEND-002). Calcula el **fee de plataforma** (Ff)
 * que Fluvia cobra por una transacción — el ingreso de Fluvia (`platform.fees`).
 * NO calcula el fee del proveedor (Fp), que es un costo determinado por el
 * adquirente. Abstracción swappable: el modelo comercial evolucionará (PEND-002
 * fija "2% por transacción por el momento"; mañana podría ser mixto/por volumen).
 */
export interface FeeSchedule {
  /** Fee de plataforma (Ff) para un monto bruto. Debe cumplir 0 ≤ Ff ≤ monto. */
  platformFee(amount: Money): Money;
}

/**
 * Fee plano en **basis points** sobre el monto bruto (PEND-002: 2% = 200 bps).
 * Usa `Money.allocate` (reparto por mayor residuo) para redondear a la unidad
 * menor sin perder ni crear unidades y garantizando `Ff ≤ monto` por
 * construcción. `bps` en [0, 10000] (0% a 100%).
 */
export class FlatBpsFeeSchedule implements FeeSchedule {
  constructor(private readonly bps: number) {
    if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
      throw new Error(`platform fee bps must be an integer in [0, 10000], got ${bps}`);
    }
  }

  platformFee(amount: Money): Money {
    if (this.bps === 0 || amount.isZero()) return Money.zero(amount.currency);
    // allocate([Ff_bps, resto_bps]): el primer trozo es Ff = round(monto·bps/10000)
    // por mayor residuo; Ff + resto == monto exacto, así que Ff nunca excede monto.
    return amount.allocate([this.bps, 10_000 - this.bps])[0]!;
  }
}

/** Sin fee de plataforma. Para tests que no ejercen pricing y para entornos que
 * deliberadamente no cobran (config bps = 0). */
export const ZERO_FEE_SCHEDULE: FeeSchedule = new FlatBpsFeeSchedule(0);
