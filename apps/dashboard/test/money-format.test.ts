import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatAmount, minorToDecimalString } from '../app/lib/money-format';
import { parseMajorAmount } from '../app/lib/pos-money';

const nbsp = (s: string) => s.replace(/\u00a0/g, ' ');

describe('money-format — presentación exacta', () => {
  it('VES: símbolo Bs., dos decimales, separadores locales', () => {
    expect(nbsp(formatAmount(123456, 'VES', 'es'))).toBe('Bs. 1.234,56');
    expect(nbsp(formatAmount(5, 'VES', 'es'))).toBe('Bs. 0,05');
    expect(nbsp(formatAmount(123456, 'VES', 'en'))).toBe('Bs. 1,234.56');
  });

  it('código ISO solo cuando el símbolo es ambiguo', () => {
    expect(nbsp(formatAmount(123456, 'VES', 'es', { code: true }))).toBe('Bs. 1.234,56 VES');
    expect(nbsp(formatAmount(12000, 'COP', 'es', { code: true }))).toBe('$ 12.000 COP');
    expect(nbsp(formatAmount(1250, 'USD', 'es', { code: true }))).toBe('US$ 12,50');
  });

  it('las monedas existentes no cambian (COP sigue con exponente de presentación 0)', () => {
    expect(nbsp(formatAmount(4800, 'COP', 'es'))).toBe('$ 4.800');
    expect(nbsp(formatAmount(1250, 'USD', 'es'))).toBe('US$ 12,50');
    expect(nbsp(formatAmount(1250, 'USD', 'en'))).toBe('$12.50');
    expect(nbsp(formatAmount(1500, 'CLP', 'es'))).toBe('CLP 1.500');
  });

  it('sin coma flotante: enteros grandes y string/bigint exactos', () => {
    // 2^53 - 1 en céntimos: con /100 en double saldría ...409,91
    expect(nbsp(formatAmount(Number.MAX_SAFE_INTEGER, 'VES', 'es'))).toBe(
      'Bs. 90.071.992.547.409,91'
    );
    expect(nbsp(formatAmount('900719925474099312', 'VES', 'es'))).toBe(
      'Bs. 9.007.199.254.740.993,12'
    );
    expect(nbsp(formatAmount(-1050n, 'VES', 'es'))).toBe('-Bs. 10,50');
    expect(minorToDecimalString(7, 2)).toBe('0.07');
    expect(minorToDecimalString(-7, 2)).toBe('-0.07');
    expect(minorToDecimalString(1234, 0)).toBe('1234');
  });

  it('el dashboard y el checkout usan el MISMO archivo', () => {
    const a = readFileSync(resolve(__dirname, '../app/lib/money-format.ts'), 'utf8');
    const b = readFileSync(resolve(__dirname, '../../checkout/app/lib/money-format.ts'), 'utf8');
    expect(b).toBe(a);
  });
});

describe('parseMajorAmount — VES', () => {
  it('acepta coma o punto y hasta dos decimales', () => {
    expect(parseMajorAmount('1234,56', 'VES')).toEqual({ ok: true, minor: 123456 });
    expect(parseMajorAmount('0.1', 'VES')).toEqual({ ok: true, minor: 10 });
    expect(parseMajorAmount('12', 'VES')).toEqual({ ok: true, minor: 1200 });
  });
  it('rechaza un tercer decimal (nunca redondea)', () => {
    expect(parseMajorAmount('10,005', 'VES')).toEqual({ ok: false, error: 'decimals' });
  });
});
