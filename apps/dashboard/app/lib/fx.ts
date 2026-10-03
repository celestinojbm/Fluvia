import { formatAmount, minorToDecimalString, type Locale } from './money-format';

/**
 * Equivalencias de REFERENCIA (solo presentación). Nunca convierte fondos,
 * nunca cambia la moneda de una cuenta, un pedido o un cobro: toma un importe
 * en su moneda original y calcula cuánto «equivale» en la moneda de
 * visualización elegida con la tasa publicada que expone la API
 * (GET /v1/fx/rates).
 *
 *  - Aritmética decimal EXACTA (BigInt racional). Solo se redondea al final,
 *    para mostrar (half-up a 2 decimales; la tasa usada a 8).
 *  - Pivote en bolívares: USD/Bs y EUR/Bs oficiales del BCV; USDT/Bs como
 *    referencia cruzada (USDT/USD de mercado × USD/Bs BCV). Nunca USDT = USD.
 *  - Sin tasa utilizable ⇒ null: la interfaz dice «No disponible», jamás 0.
 */

export type DisplayCurrency = 'USD' | 'VES' | 'EUR' | 'USDT';
export const DISPLAY_CURRENCIES: DisplayCurrency[] = ['USD', 'VES', 'EUR', 'USDT'];
export const DEFAULT_DISPLAY: DisplayCurrency = 'USD';
/** Cookie y clave local de la preferencia (POR DISPOSITIVO, no por cuenta). */
export const DISPLAY_COOKIE = 'fluvia_display';
export const DISPLAY_STORAGE_KEY = 'fluvia.display';

/** Etiqueta visible de una moneda: VES se muestra «Bs» (código interno VES). */
export function currencyLabel(code: string): string {
  return code === 'VES' ? 'Bs' : code;
}

export function isDisplayCurrency(v: unknown): v is DisplayCurrency {
  return typeof v === 'string' && (DISPLAY_CURRENCIES as string[]).includes(v);
}

export type FxStatus = 'vigente' | 'desactualizada' | 'no_disponible' | 'datos_de_prueba';

/** Forma de cable (snake_case) de una referencia de /v1/fx/rates. */
export interface FxReference {
  pair: 'USD/VES' | 'EUR/VES' | 'USDT/USD' | 'USDT/VES';
  kind: 'official' | 'market' | 'cross';
  label: string;
  source: string;
  method: string;
  unit: string;
  rate: string | null;
  value_date: string | null;
  source_updated_at: string | null;
  fetched_at: string | null;
  status: FxStatus;
  detail: string;
  warning: string | null;
  next: { value_date: string; rate: string } | null;
}

export interface FxRates {
  generated_at: string;
  timezone: string;
  today: string;
  references: FxReference[];
  direct_usdt_ves: { status: 'sin_fuente'; detail: string };
}

/** Estado vacío honesto (API sin la ruta o caída): todo «No disponible». */
export const NO_RATES: FxRates | null = null;

const RATE_RE = /^(0|[1-9]\d{0,17})(\.\d{1,12})?$/;

/** Racional exacto n/d (d > 0). */
interface Q {
  n: bigint;
  d: bigint;
}

function q(text: string): Q | null {
  if (!RATE_RE.test(text)) return null;
  const [w, f = ''] = text.split('.');
  const n = BigInt(`${w}${f}`);
  if (n <= 0n) return null; // una tasa cero o negativa no es una tasa
  return { n, d: 10n ** BigInt(f.length) };
}

/** Referencia por par, solo si trae una tasa válida. */
export function reference(rates: FxRates | null, pair: FxReference['pair']): FxReference | null {
  const r = rates?.references.find((x) => x.pair === pair) ?? null;
  return r && r.rate && q(r.rate) ? r : null;
}

/** Bolívares por una unidad de `cur` y la referencia que lo respalda. */
function vesPer(rates: FxRates | null, cur: string): { v: Q; ref: FxReference | null } | null {
  if (cur === 'VES') return { v: { n: 1n, d: 1n }, ref: null };
  const pair =
    cur === 'USD' ? 'USD/VES' : cur === 'EUR' ? 'EUR/VES' : cur === 'USDT' ? 'USDT/VES' : null;
  if (!pair) return null;
  const ref = reference(rates, pair);
  const v = ref?.rate ? q(ref.rate) : null;
  return v && ref ? { v, ref } : null;
}

/** Redondeo half-up de un racional no negativo/negativo a `places` decimales. */
export function roundQ(x: Q, places: number): string {
  const scale = 10n ** BigInt(places);
  const neg = x.n < 0n;
  const num = (neg ? -x.n : x.n) * scale;
  let int = num / x.d;
  if ((num % x.d) * 2n >= x.d) int += 1n;
  const s = minorToDecimalString(int, places);
  return neg && int !== 0n ? `-${s}` : s;
}

export interface Conversion {
  /** Importe convertido, decimal exacto redondeado a 2 decimales (texto). */
  value: string;
  /** Mismo importe en unidades menores (2 decimales) para formatear. */
  minor: bigint;
  /** 1 `from` = `rate` `to`, a 8 decimales, solo para mostrar. */
  rate: string;
  /** Referencias usadas (fuente, fecha, estado) para citar la conversión. */
  refs: FxReference[];
  /** Peor estado de las referencias usadas. */
  status: FxStatus;
}

const RANK: Record<FxStatus, number> = {
  vigente: 0,
  datos_de_prueba: 1,
  desactualizada: 2,
  no_disponible: 3,
};

/**
 * Convierte un importe DECIMAL (texto, p. ej. "1234.56") de `from` a `to`.
 * Devuelve null si falta alguna tasa o el importe no es válido.
 */
export function convertDecimal(
  rates: FxRates | null,
  amount: string,
  from: string,
  to: string
): Conversion | null {
  const m = /^(-)?(\d{1,30})(?:\.(\d{1,12}))?$/.exec(amount.trim());
  if (!m) return null;
  const a: Q = {
    n: BigInt(`${m[1] ?? ''}${m[2]}${m[3] ?? ''}`),
    d: 10n ** BigInt((m[3] ?? '').length),
  };
  const f = vesPer(rates, from);
  const t = vesPer(rates, to);
  if (!f || !t) return null;
  // a · (Bs por 1 from) / (Bs por 1 to)
  const res: Q = { n: a.n * f.v.n * t.v.d, d: a.d * f.v.d * t.v.n };
  const rate: Q = { n: f.v.n * t.v.d, d: f.v.d * t.v.n };
  const value = roundQ(res, 2);
  const refs = [f.ref, t.ref].filter((r): r is FxReference => r !== null);
  const status = refs.reduce<FxStatus>(
    (w, r) => (RANK[r.status] > RANK[w] ? r.status : w),
    'vigente'
  );
  return {
    value,
    minor: BigInt(value.replace('.', '')),
    rate: roundQ(rate, 8),
    refs,
    status,
  };
}

/** Igual que `convertDecimal`, desde unidades menores de la moneda original. */
export function convertMinor(
  rates: FxRates | null,
  minor: string | number | bigint,
  from: string,
  to: string
): Conversion | null {
  // Bs, USD, EUR y USDT usan 2 decimales de presentación; otras (COP…) no
  // tienen tasa de referencia aquí.
  if (!['VES', 'USD', 'EUR', 'USDT'].includes(from)) return null;
  return convertDecimal(rates, minorToDecimalString(minor, 2), from, to);
}

/**
 * Formato de presentación para las cuatro monedas de visualización.
 * USD/EUR/Bs vía el formateador compartido; USDT (no es ISO 4217) a mano con
 * los mismos separadores: «1.234,56 USDT».
 */
export function formatDisplay(minor: bigint, cur: string, locale: Locale = 'es'): string {
  if (cur !== 'USDT') return formatAmount(minor, cur, locale);
  const nf = new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'es-CO', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const text = nf.format(minorToDecimalString(minor, 2) as unknown as number);
  return `${text} USDT`;
}

/** Número con separadores locales y exactamente `places` decimales (tasas). */
export function formatRate(decimal: string, places = 4): string {
  const x = q(decimal);
  if (!x) return decimal;
  const rounded = roundQ(x, places);
  return new Intl.NumberFormat('es-CO', {
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  }).format(rounded as unknown as number);
}

/**
 * Convierte la entrada de la calculadora («1.234,56», «1234.56», «1234,5») a
 * decimal canónico. Acepta coma decimal (es-VE) o punto si no hay coma.
 */
export function parseUserAmount(raw: string): string | null {
  const t = raw.trim().replace(/\s/g, '');
  if (!t) return null;
  let norm: string;
  if (t.includes(',')) {
    if (!/^\d{1,3}(\.\d{3})*(,\d{1,12})?$|^\d+(,\d{1,12})?$/.test(t)) return null;
    norm = t.replace(/\./g, '').replace(',', '.');
  } else {
    if (!/^\d+(\.\d{1,12})?$/.test(t)) return null;
    norm = t;
  }
  norm = norm.replace(/^0+(?=\d)/, '');
  return norm.length > 31 ? null : norm;
}

const CARACAS_DATE = new Intl.DateTimeFormat('es-VE', {
  timeZone: 'America/Caracas',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});
const CARACAS_TIME = new Intl.DateTimeFormat('es-VE', {
  timeZone: 'America/Caracas',
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** «2026-10-02» → «02/10/2026» (fecha civil; ya está en hora de Caracas). */
export function civilDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

/** Instante → «03/10, 14:55» en America/Caracas. */
export function caracasTime(iso: string): string {
  return CARACAS_TIME.format(new Date(iso));
}

export function caracasDay(iso: string): string {
  return CARACAS_DATE.format(new Date(iso));
}

export const STATUS_TEXT: Record<FxStatus, string> = {
  vigente: 'Vigente',
  desactualizada: 'Desactualizada',
  no_disponible: 'No disponible',
  datos_de_prueba: 'Datos de prueba',
};

/** Cita breve de una referencia: «BCV · Fecha Valor 02/10/2026». */
export function citation(r: FxReference): string {
  if (r.kind === 'official' && r.value_date) {
    return `${r.source} · Fecha Valor ${civilDate(r.value_date)}`;
  }
  if (r.kind === 'market' && r.source_updated_at) {
    return `${r.source} · ${caracasTime(r.source_updated_at)} (Caracas)`;
  }
  if (r.kind === 'cross') {
    return `Referencia cruzada${r.value_date ? ` · BCV ${civilDate(r.value_date)}` : ''}`;
  }
  return r.source;
}
