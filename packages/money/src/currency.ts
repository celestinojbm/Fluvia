import { UnknownCurrencyError } from './errors.js';

/**
 * Registro de monedas soportadas por Fluvia con su exponente ISO-4217.
 * El exponente define cuantos digitos decimales tiene la unidad mayor:
 * USD exponente 2 => 1 USD = 100 unidades menores (centavos).
 * CLP/JPY exponente 0 => sin decimales.
 */
export const CURRENCIES = {
  USD: { exponent: 2 },
  EUR: { exponent: 2 },
  GBP: { exponent: 2 },
  MXN: { exponent: 2 },
  BRL: { exponent: 2 },
  COP: { exponent: 2 },
  ARS: { exponent: 2 },
  PEN: { exponent: 2 },
  CLP: { exponent: 0 },
  JPY: { exponent: 0 },
  /**
   * Bolívar venezolano. Código y exponente verificados en la lista oficial
   * ISO 4217 «List one» publicada por la agencia de mantenimiento (SIX,
   * publicación 2026-09-17): VES / 928 / 2 decimales. La enmienda 170 (2021)
   * añadió VED/926 solo «para necesidades internas» de la reconversión y
   * declara VES el código válido para transacciones; el BCV no adopta VED.
   * Fuente y huella: docs/product/bolivares.md.
   */
  VES: { exponent: 2 },
} as const;

export type CurrencyCode = keyof typeof CURRENCIES;

export const CURRENCY_CODES = Object.keys(CURRENCIES) as CurrencyCode[];

export function isCurrencyCode(code: string): code is CurrencyCode {
  return Object.prototype.hasOwnProperty.call(CURRENCIES, code);
}

export function assertCurrencyCode(code: string): asserts code is CurrencyCode {
  if (!isCurrencyCode(code)) {
    throw new UnknownCurrencyError(code);
  }
}

export function currencyExponent(code: CurrencyCode): number {
  return CURRENCIES[code].exponent;
}
