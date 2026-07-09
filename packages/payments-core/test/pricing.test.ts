import { describe, expect, it } from 'vitest';
import { Money } from '@fluvia/money';
import { FlatBpsFeeSchedule, ZERO_FEE_SCHEDULE } from '../src/index.js';

/**
 * F4-05c — motor de fees (PEND-002: 2% por transacción). Lógica pura, sin PG.
 */

const cop = (n: number) => Money.of(n, 'COP');

describe('FlatBpsFeeSchedule (motor de fees)', () => {
  const two = new FlatBpsFeeSchedule(200); // 2%

  it('GOLDEN: 2% de montos que dividen exacto', () => {
    expect(two.platformFee(cop(100_000)).amount).toBe(2_000n);
    expect(two.platformFee(cop(50_000)).amount).toBe(1_000n);
    expect(two.platformFee(cop(1_000)).amount).toBe(20n);
  });

  it('redondea por mayor residuo y NUNCA excede el monto', () => {
    // 12345 · 2% = 246.9 → 247 (el trozo del fee toma la unidad del mayor residuo).
    expect(two.platformFee(cop(12_345)).amount).toBe(247n);
    // 49 · 2% = 0.98 → 1 (mayor residuo va al fee).
    expect(two.platformFee(cop(49)).amount).toBe(1n);
    // Invariante 0 ≤ Ff ≤ monto para un barrido de montos.
    for (const m of [1, 7, 49, 99, 12_345, 999_999, 1]) {
      const fee = two.platformFee(cop(m));
      expect(fee.amount >= 0n).toBe(true);
      expect(fee.amount <= BigInt(m)).toBe(true);
    }
  });

  it('bps=0 y ZERO_FEE_SCHEDULE no cobran', () => {
    expect(new FlatBpsFeeSchedule(0).platformFee(cop(100_000)).amount).toBe(0n);
    expect(ZERO_FEE_SCHEDULE.platformFee(cop(100_000)).amount).toBe(0n);
  });

  it('monto cero ⇒ fee cero', () => {
    expect(two.platformFee(cop(0)).amount).toBe(0n);
  });

  it('preserva la moneda del monto', () => {
    expect(two.platformFee(Money.of(100_000, 'USD')).currency).toBe('USD');
  });

  it('rechaza bps fuera de [0, 10000] o no enteros', () => {
    expect(() => new FlatBpsFeeSchedule(-1)).toThrow();
    expect(() => new FlatBpsFeeSchedule(10_001)).toThrow();
    expect(() => new FlatBpsFeeSchedule(1.5)).toThrow();
  });
});
