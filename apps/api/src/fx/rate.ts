/**
 * Tasas como DECIMALES EXACTOS en texto (nunca float en la API ni en la base).
 * Una tasa válida es positiva, finita y con a lo sumo 12 decimales.
 */
const RATE_RE = /^(0|[1-9]\d{0,11})(\.\d{1,12})?$/;

export class InvalidRateError extends Error {
  constructor(raw: unknown) {
    super(`tasa inválida: ${String(raw)}`);
    this.name = 'InvalidRateError';
  }
}

/** Normaliza «871,36890000» (coma decimal, como publica el BCV) o «871.3689». */
export function parseDecimalRate(raw: string): string {
  const s = raw.trim().replace(/\s/g, '');
  // Formato venezolano: «.» miles y «,» decimal. Si hay coma, es la decimal.
  const norm = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s;
  if (!RATE_RE.test(norm)) throw new InvalidRateError(raw);
  if (/^0(\.0+)?$/.test(norm)) throw new InvalidRateError(raw);
  return norm;
}

/** Número de la hoja XLS (double) → texto con 8 decimales (precisión publicada por el BCV). */
export function rateFromDouble(n: number, decimals = 8): string {
  if (!Number.isFinite(n) || n <= 0) throw new InvalidRateError(n);
  return parseDecimalRate(n.toFixed(decimals));
}
