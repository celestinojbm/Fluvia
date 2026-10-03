/**
 * Aritmética decimal EXACTA sobre texto (BigInt escalado). Solo se redondea
 * al final, para presentar.
 */
export interface Dec {
  n: bigint; // numerador entero
  s: number; // escala (decimales)
}

export function dec(text: string): Dec {
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!m) throw new Error(`decimal inválido: ${text}`);
  const frac = m[3] ?? '';
  const n = BigInt(`${m[2]}${frac}`);
  return { n: m[1] ? -n : n, s: frac.length };
}

export function mul(a: Dec, b: Dec): Dec {
  return { n: a.n * b.n, s: a.s + b.s };
}

/** Redondeo half-up a `places` decimales → texto. */
export function toFixed(a: Dec, places: number): string {
  let n = a.n;
  const neg = n < 0n;
  if (neg) n = -n;
  if (a.s > places) {
    const div = 10n ** BigInt(a.s - places);
    const q = n / div;
    const r = n % div;
    n = r * 2n >= div ? q + 1n : q;
  } else {
    n = n * 10n ** BigInt(places - a.s);
  }
  const digits = n.toString().padStart(places + 1, '0');
  const whole = digits.slice(0, digits.length - places);
  const frac = places ? `.${digits.slice(digits.length - places)}` : '';
  return `${neg ? '-' : ''}${whole}${frac}`;
}
