import { displayExponent } from '../messages';

/**
 * Importes del POS: el cajero teclea unidades MAYORES ("12.50"); la API recibe
 * unidades MENORES enteras. La conversión usa `displayExponent` — la misma regla
 * con la que `formatAmount` muestra el importe en dashboard y checkout — para
 * que lo tecleado, lo mostrado y lo que ve el comprador coincidan.
 *
 * Sin floats: la parte entera y la decimal se combinan con BigInt y el resultado
 * se acota a entero seguro (la API rechaza lo que no lo sea).
 */

/**
 * Monedas del registro de `@fluvia/money` (packages/money/src/currency.ts). El
 * POS no añade ni quita monedas: la lista del dominio es la fuente de verdad
 * (un test comprueba la paridad).
 */
export const POS_CURRENCIES = [
  'USD',
  'EUR',
  'GBP',
  'MXN',
  'BRL',
  'COP',
  'ARS',
  'PEN',
  'CLP',
  'JPY',
  'VES',
] as const;

export type AmountError = 'empty' | 'format' | 'decimals' | 'zero' | 'too_large';

export type ParsedAmount = { ok: true; minor: number } | { ok: false; error: AmountError };

const AMOUNT_RE = /^(\d+)(?:[.,](\d+))?$/;

export function parseMajorAmount(input: string, currency: string): ParsedAmount {
  const text = input.trim();
  if (text === '') return { ok: false, error: 'empty' };
  const m = AMOUNT_RE.exec(text);
  if (!m) return { ok: false, error: 'format' };
  const exponent = displayExponent(currency);
  const whole = m[1]!;
  const frac = m[2] ?? '';
  if (frac.length > exponent) return { ok: false, error: 'decimals' };
  const minor = BigInt(whole) * 10n ** BigInt(exponent) + BigInt(frac.padEnd(exponent, '0') || '0');
  if (minor === 0n) return { ok: false, error: 'zero' };
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) return { ok: false, error: 'too_large' };
  return { ok: true, minor: Number(minor) };
}
