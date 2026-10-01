import { describe, expect, it } from 'vitest';
import {
  INSTALLMENT_DEMO_TERMS,
  buildSchedule,
  isAllowedInstallmentCount,
  splitInstallments,
} from '../src/installments-calc.js';

describe('reparto de cuotas (unidades menores, sin floats)', () => {
  it('Σ cuotas = total exactamente y el resto va a las primeras', () => {
    expect(splitInstallments(10_000n, 3)).toEqual([3_334n, 3_333n, 3_333n]);
    expect(splitInstallments(10_002n, 4)).toEqual([2_501n, 2_501n, 2_500n, 2_500n]);
    expect(splitInstallments(12n, 6)).toEqual([2n, 2n, 2n, 2n, 2n, 2n]);
  });

  it('propiedad: para muchos totales y conteos, suma exacta y diferencia ≤ 1', () => {
    for (const count of [2, 3, 4, 6, 12]) {
      for (let t = BigInt(count); t < 5_000n; t += 37n) {
        const parts = splitInstallments(t, count);
        expect(parts.reduce((a, b) => a + b, 0n)).toBe(t);
        const max = parts.reduce((a, b) => (b > a ? b : a));
        const min = parts.reduce((a, b) => (b < a ? b : a));
        expect(max - min <= 1n).toBe(true);
        expect(parts.every((p) => p > 0n)).toBe(true);
      }
    }
    // Entero grande (sin pérdida de precisión).
    const big = 9_007_199_254_740_991n;
    expect(splitInstallments(big, 6).reduce((a, b) => a + b, 0n)).toBe(big);
  });

  it('rechaza conteos fuera de rango y totales menores que el nº de cuotas', () => {
    expect(() => splitInstallments(100n, 1)).toThrow(RangeError);
    expect(() => splitInstallments(100n, 13)).toThrow(RangeError);
    expect(() => splitInstallments(2n, 3)).toThrow(RangeError);
    expect(() => splitInstallments(0n, 3)).toThrow(RangeError);
  });

  it('calendario: primera cuota hoy (importe inicial), luego cada intervalo (UTC)', () => {
    const s = buildSchedule(9_000n, 3, '2026-12-25', 15);
    expect(s.map((x) => x.dueDate)).toEqual(['2026-12-25', '2027-01-09', '2027-01-24']);
    expect(s.map((x) => x.seq)).toEqual([1, 2, 3]);
  });

  it('los parámetros son de DEMOSTRACIÓN y sin intereses', () => {
    expect(INSTALLMENT_DEMO_TERMS.interestRate).toBe(0);
    expect(INSTALLMENT_DEMO_TERMS.fees).toBe(0);
    expect(INSTALLMENT_DEMO_TERMS.version).toMatch(/^demo-/);
    expect(isAllowedInstallmentCount(4)).toBe(true);
    expect(isAllowedInstallmentCount(5)).toBe(false);
  });
});
