/**
 * Presentación de importes (dashboard y checkout comparten ESTE archivo,
 * copiado byte a byte; un test exige que sigan idénticos).
 *
 * - Entrada: unidades MENORES enteras (number seguro, string entero o bigint).
 *   Sin coma flotante: el decimal se arma con BigInt y se entrega a
 *   Intl.NumberFormat como cadena decimal exacta.
 * - Exponente de PRESENTACIÓN: 0 para COP/JPY/CLP y 2 para el resto (incluido
 *   VES). Para COP difiere de `@fluvia/money` (2): discrepancia preexistente
 *   registrada como PEND-008; aquí NO se toca.
 * - Símbolos: VES se muestra «Bs.» (símbolo del BCV desde la reconversión de
 *   2021; CLDR aún trae «Bs.S»). `code: true` añade el código ISO cuando el
 *   símbolo solo no basta (COP «$», VES «Bs.»), para vistas con varias monedas
 *   y documentos para el comprador.
 * - No convierte, no redondea y no suma monedas distintas.
 */

export type Locale = 'es' | 'en';

const ZERO_EXPONENT = new Set(['COP', 'JPY', 'CLP']);
const SYMBOL_OVERRIDE: Record<string, string> = { VES: 'Bs.' };
const AMBIGUOUS_SYMBOL = new Set(['COP', 'VES']);

export function displayExponent(currency: string): 0 | 2 {
  return ZERO_EXPONENT.has(currency) ? 0 : 2;
}

/** Unidades menores → cadena decimal exacta ("123456", 2 → "1234.56"). */
export function minorToDecimalString(
  amountMinor: number | string | bigint,
  exponent: number
): string {
  let v: bigint;
  try {
    v = typeof amountMinor === 'bigint' ? amountMinor : BigInt(amountMinor);
  } catch {
    return String(amountMinor);
  }
  const neg = v < 0n;
  const digits = (neg ? -v : v).toString().padStart(exponent + 1, '0');
  const whole = digits.slice(0, digits.length - exponent);
  const frac = exponent > 0 ? `.${digits.slice(digits.length - exponent)}` : '';
  return `${neg ? '-' : ''}${whole}${frac}`;
}

export interface FormatOptions {
  /** Añade el código ISO cuando el símbolo es ambiguo (COP, VES). */
  code?: boolean;
}

export function formatAmount(
  amountMinor: number | string | bigint,
  currency: string,
  locale: Locale,
  opts: FormatOptions = {}
): string {
  const exponent = displayExponent(currency);
  const decimal = minorToDecimalString(amountMinor, exponent);
  let text: string;
  try {
    const nf = new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'es-CO', {
      style: 'currency',
      currency,
      minimumFractionDigits: exponent,
      maximumFractionDigits: exponent,
    });
    // Intl acepta la cadena decimal exacta (sin pasar por double).
    const parts = nf.formatToParts(decimal as unknown as number);
    const symbol = SYMBOL_OVERRIDE[currency];
    text = parts.map((p) => (p.type === 'currency' && symbol ? symbol : p.value)).join('');
    // «VES 12.50» en inglés → «Bs. 12.50»: el separador viene en `literal`.
  } catch {
    text = `${decimal} ${currency}`;
  }
  if (opts.code && AMBIGUOUS_SYMBOL.has(currency)) text = `${text} ${currency}`;
  return text;
}

/** Nombre legible de la moneda para selectores y encabezados. */
export function currencyName(currency: string, locale: Locale): string {
  const names: Record<string, [string, string]> = {
    VES: ['Bolívar venezolano', 'Venezuelan bolívar'],
    USD: ['Dólar estadounidense', 'US dollar'],
    COP: ['Peso colombiano', 'Colombian peso'],
    EUR: ['Euro', 'Euro'],
  };
  const n = names[currency];
  if (n) return locale === 'en' ? n[1] : n[0];
  try {
    return (
      new Intl.DisplayNames(locale === 'en' ? 'en' : 'es', { type: 'currency' }).of(currency) ??
      currency
    );
  } catch {
    return currency;
  }
}
