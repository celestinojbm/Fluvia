/**
 * Cálculo de cuotas — función PURA, en unidades menores (bigint), sin floats.
 *
 * Reparto: base = ⌊total / n⌋ y el resto r (< n) se distribuye sumando UNA
 * unidad menor a las r PRIMERAS cuotas. Así ninguna cuota difiere de otra en
 * más de una unidad menor y Σ cuotas = total EXACTAMENTE (lo exige también el
 * motor, 0050). La primera cuota es el «importe inicial», que vence el día de
 * la confirmación; las demás cada `intervalDays` días (fechas de calendario
 * UTC, solo informativas: nada se cobra ni se marca por el paso del tiempo).
 */

/**
 * PARÁMETROS DE DEMOSTRACIÓN — NO son una política comercial aprobada, ni una
 * oferta de financiación. Sin intereses, sin comisiones, sin mora. Cambiarlos
 * exige subir `version` (queda grabada en cada plan).
 */
export const INSTALLMENT_DEMO_TERMS = {
  version: 'demo-2026-10',
  /** Número de cuotas que el comprador puede elegir. */
  counts: [3, 4, 6] as const,
  /** Días entre cuotas (quincenal). */
  intervalDays: 15,
  /** Sin intereses ni comisiones: es una simulación de experiencia. */
  interestRate: 0,
  fees: 0,
} as const;

export type InstallmentCount = (typeof INSTALLMENT_DEMO_TERMS.counts)[number];

export function isAllowedInstallmentCount(n: number): n is InstallmentCount {
  return (INSTALLMENT_DEMO_TERMS.counts as readonly number[]).includes(n);
}

export interface ScheduledInstallment {
  seq: number;
  amount: bigint;
  /** Fecha de vencimiento (YYYY-MM-DD, UTC). */
  dueDate: string;
}

function addDaysUtc(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  const t = Date.UTC(y, m - 1, d) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** Fecha UTC (YYYY-MM-DD) de un instante. */
export function utcDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

export function splitInstallments(total: bigint, count: number): bigint[] {
  if (!Number.isInteger(count) || count < 2 || count > 12) {
    throw new RangeError('installment count must be an integer between 2 and 12');
  }
  if (total <= 0n) throw new RangeError('total must be positive');
  const n = BigInt(count);
  if (total < n) throw new RangeError('total too small for this number of installments');
  const base = total / n;
  const remainder = total % n;
  return Array.from({ length: count }, (_, i) => base + (BigInt(i) < remainder ? 1n : 0n));
}

export function buildSchedule(
  total: bigint,
  count: number,
  startDate: string,
  intervalDays: number = INSTALLMENT_DEMO_TERMS.intervalDays
): ScheduledInstallment[] {
  return splitInstallments(total, count).map((amount, i) => ({
    seq: i + 1,
    amount,
    dueDate: addDaysUtc(startDate, i * intervalDays),
  }));
}
