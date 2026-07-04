import { describe, expect, it } from 'vitest';
import {
  CurrencyMismatchError,
  InvalidAmountError,
  Money,
  MoneySchema,
  PrecisionError,
  UnknownCurrencyError,
  moneyFromPayload,
} from '../src/index.js';

describe('Money.of', () => {
  it('accepts bigint, safe integers and integer strings as minor units', () => {
    expect(Money.of(1025n, 'USD').amount).toBe(1025n);
    expect(Money.of(1025, 'USD').amount).toBe(1025n);
    expect(Money.of('1025', 'USD').amount).toBe(1025n);
    expect(Money.of('-500', 'USD').amount).toBe(-500n);
  });

  it('rejects unsafe integers and non-integer strings', () => {
    expect(() => Money.of(10.5, 'USD')).toThrow(InvalidAmountError);
    expect(() => Money.of(Number.MAX_SAFE_INTEGER + 1, 'USD')).toThrow(InvalidAmountError);
    expect(() => Money.of('10.5', 'USD')).toThrow(InvalidAmountError);
    expect(() => Money.of('abc', 'USD')).toThrow(InvalidAmountError);
  });

  it('rejects unknown currencies', () => {
    expect(() => Money.of(100n, 'XXX')).toThrow(UnknownCurrencyError);
    expect(() => Money.of(100n, 'usd')).toThrow(UnknownCurrencyError);
  });
});

describe('Money.fromDecimal', () => {
  it('parses major units into minor units per currency exponent', () => {
    expect(Money.fromDecimal('10.25', 'USD').amount).toBe(1025n);
    expect(Money.fromDecimal('10', 'USD').amount).toBe(1000n);
    expect(Money.fromDecimal('10.5', 'USD').amount).toBe(1050n);
    expect(Money.fromDecimal('-0.01', 'USD').amount).toBe(-1n);
  });

  it('handles zero-decimal currencies (CLP, JPY)', () => {
    expect(Money.fromDecimal('1500', 'CLP').amount).toBe(1500n);
    expect(Money.fromDecimal('1500', 'JPY').amount).toBe(1500n);
  });

  it('never silently rounds: excess precision throws', () => {
    expect(() => Money.fromDecimal('10.255', 'USD')).toThrow(PrecisionError);
    expect(() => Money.fromDecimal('10.5', 'JPY')).toThrow(PrecisionError);
  });

  it('rejects garbage', () => {
    expect(() => Money.fromDecimal('10,25', 'USD')).toThrow(InvalidAmountError);
    expect(() => Money.fromDecimal('1e5', 'USD')).toThrow(InvalidAmountError);
    expect(() => Money.fromDecimal('', 'USD')).toThrow(InvalidAmountError);
  });
});

describe('arithmetic', () => {
  it('adds and subtracts exactly with bigint', () => {
    const a = Money.of(1n, 'USD');
    const b = Money.fromDecimal('0.02', 'USD');
    expect(a.add(b).amount).toBe(3n); // 0.01 + 0.02 = 0.03 exacto (no 0.030000000000000002)
    expect(b.subtract(a).amount).toBe(1n);
  });

  it('refuses cross-currency operations', () => {
    const usd = Money.of(100n, 'USD');
    const eur = Money.of(100n, 'EUR');
    expect(() => usd.add(eur)).toThrow(CurrencyMismatchError);
    expect(() => usd.subtract(eur)).toThrow(CurrencyMismatchError);
    expect(() => usd.compare(eur)).toThrow(CurrencyMismatchError);
  });

  it('multiply only accepts integer factors', () => {
    expect(Money.of(100n, 'USD').multiply(3).amount).toBe(300n);
    expect(() => Money.of(100n, 'USD').multiply(0.5)).toThrow(InvalidAmountError);
  });

  it('predicates and comparison', () => {
    expect(Money.zero('USD').isZero()).toBe(true);
    expect(Money.of(-1n, 'USD').isNegative()).toBe(true);
    expect(Money.of(1n, 'USD').isPositive()).toBe(true);
    expect(Money.of(1n, 'USD').compare(Money.of(2n, 'USD'))).toBe(-1);
    expect(Money.of(2n, 'USD').equals(Money.of(2n, 'USD'))).toBe(true);
  });
});

describe('allocate', () => {
  it('never loses nor creates a single minor unit', () => {
    const parts = Money.of(100n, 'USD').allocate([1, 1, 1]);
    expect(parts.map((p) => p.amount)).toEqual([34n, 33n, 33n]);
    expect(parts.reduce((acc, p) => acc.add(p), Money.zero('USD')).amount).toBe(100n);
  });

  it('splits by weights', () => {
    const parts = Money.of(1000n, 'USD').allocate([70, 30]);
    expect(parts.map((p) => p.amount)).toEqual([700n, 300n]);
  });

  it('handles negative amounts consistently', () => {
    const parts = Money.of(-101n, 'USD').allocate([1, 1]);
    expect(parts.reduce((a, p) => a + p.amount, 0n)).toBe(-101n);
  });

  it('rejects invalid ratios', () => {
    expect(() => Money.of(100n, 'USD').allocate([])).toThrow(InvalidAmountError);
    expect(() => Money.of(100n, 'USD').allocate([0, 0])).toThrow(InvalidAmountError);
    expect(() => Money.of(100n, 'USD').allocate([1.5])).toThrow(InvalidAmountError);
    expect(() => Money.of(100n, 'USD').allocate([-1, 2])).toThrow(InvalidAmountError);
  });
});

describe('formatting and serialization', () => {
  it('renders decimal strings with correct padding', () => {
    expect(Money.of(5n, 'USD').toDecimalString()).toBe('0.05');
    expect(Money.of(-5n, 'USD').toDecimalString()).toBe('-0.05');
    expect(Money.of(1025n, 'USD').toDecimalString()).toBe('10.25');
    expect(Money.of(1500n, 'CLP').toDecimalString()).toBe('1500');
  });

  it('round-trips through JSON without precision loss', () => {
    const original = Money.of(9007199254740993n, 'USD'); // > Number.MAX_SAFE_INTEGER
    const revived = moneyFromPayload(JSON.parse(JSON.stringify(original)));
    expect(revived.equals(original)).toBe(true);
  });
});

describe('MoneySchema (Zod boundary validation)', () => {
  it('accepts valid payloads', () => {
    expect(MoneySchema.parse({ amount: '1025', currency: 'USD' })).toEqual({
      amount: '1025',
      currency: 'USD',
    });
  });

  it('rejects floats, numbers and unknown currencies', () => {
    expect(() => MoneySchema.parse({ amount: 1025, currency: 'USD' })).toThrow();
    expect(() => MoneySchema.parse({ amount: '10.25', currency: 'USD' })).toThrow();
    expect(() => MoneySchema.parse({ amount: '1025', currency: 'XXX' })).toThrow();
  });

  it('is strict: extra keys are rejected (anti mass-assignment)', () => {
    expect(() => MoneySchema.parse({ amount: '1025', currency: 'USD', isAdmin: true })).toThrow();
  });
});
