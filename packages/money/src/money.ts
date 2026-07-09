import { assertCurrencyCode, currencyExponent, type CurrencyCode } from './currency.js';
import { CurrencyMismatchError, InvalidAmountError, PrecisionError } from './errors.js';

const INTEGER_RE = /^-?\d+$/;
const DECIMAL_RE = /^(-?)(\d+)(?:\.(\d+))?$/;

/**
 * Value Object monetario de Fluvia (Directiva V3, seccion 2.3).
 *
 * Invariantes:
 * - El monto SIEMPRE se representa en unidades menores (centavos) como bigint.
 *   Nunca hay aritmetica de punto flotante.
 * - Inmutable: toda operacion retorna una nueva instancia.
 * - Toda operacion binaria exige la misma moneda (CurrencyMismatchError).
 */
export class Money {
  private constructor(
    /** Monto en unidades menores (p.ej. centavos). */
    readonly amount: bigint,
    readonly currency: CurrencyCode
  ) {
    Object.freeze(this);
  }

  /** Construye desde unidades menores. Los number deben ser enteros seguros. */
  static of(amount: bigint | number | string, currency: string): Money {
    assertCurrencyCode(currency);
    let value: bigint;
    if (typeof amount === 'bigint') {
      value = amount;
    } else if (typeof amount === 'number') {
      if (!Number.isSafeInteger(amount)) {
        throw new InvalidAmountError(
          `number amounts must be safe integers in minor units, received ${amount}`
        );
      }
      value = BigInt(amount);
    } else {
      if (!INTEGER_RE.test(amount)) {
        throw new InvalidAmountError(
          `string amounts must be integer minor units, received "${amount}"`
        );
      }
      value = BigInt(amount);
    }
    return new Money(value, currency);
  }

  static zero(currency: string): Money {
    return Money.of(0n, currency);
  }

  /**
   * Parsea una cadena decimal en unidad mayor ("10.25" USD => 1025 centavos).
   * Rechaza mas decimales que el exponente de la moneda (PrecisionError):
   * nunca redondeamos dinero silenciosamente.
   */
  static fromDecimal(text: string, currency: string): Money {
    assertCurrencyCode(currency);
    const match = DECIMAL_RE.exec(text.trim());
    if (!match) {
      throw new InvalidAmountError(`cannot parse decimal string "${text}"`);
    }
    const [, sign, whole, frac = ''] = match;
    const exponent = currencyExponent(currency);
    if (frac.length > exponent) {
      throw new PrecisionError(currency, exponent, text);
    }
    const minor =
      BigInt(whole!) * 10n ** BigInt(exponent) + BigInt(frac.padEnd(exponent, '0') || '0');
    return new Money(sign === '-' ? -minor : minor, currency);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amount + other.amount, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amount - other.amount, this.currency);
  }

  multiply(factor: bigint | number): Money {
    let f: bigint;
    if (typeof factor === 'number') {
      if (!Number.isSafeInteger(factor)) {
        throw new InvalidAmountError(
          `multiply only accepts integer factors, received ${factor}. Use allocate() for splits.`
        );
      }
      f = BigInt(factor);
    } else {
      f = factor;
    }
    return new Money(this.amount * f, this.currency);
  }

  negate(): Money {
    return new Money(-this.amount, this.currency);
  }

  abs(): Money {
    return this.amount < 0n ? this.negate() : this;
  }

  isZero(): boolean {
    return this.amount === 0n;
  }

  isNegative(): boolean {
    return this.amount < 0n;
  }

  isPositive(): boolean {
    return this.amount > 0n;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.amount === other.amount;
  }

  /** -1 | 0 | 1. Exige misma moneda. */
  compare(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other);
    if (this.amount < other.amount) return -1;
    if (this.amount > other.amount) return 1;
    return 0;
  }

  /**
   * Reparte el monto segun ratios enteros positivos sin perder ni crear
   * una sola unidad menor (metodo de mayor residuo). La suma de las partes
   * es SIEMPRE identica al monto original.
   *
   * V2-R5 (re-auditoria v2): el residuo se reparte round-robin EMPEZANDO en el
   * indice 0, asi que en un split con residuo el participante 0 recibe la primera
   * unidad menor extra. Es DETERMINISTA a proposito (misma entrada => misma
   * salida, reproducible en tests y auditoria). Si un caller necesita repartir el
   * sesgo (p. ej. muchos splits de fees con el mismo primer ratio), debe barajar
   * el orden de los ratios el mismo (el algoritmo no lo hace por diseno).
   */
  allocate(ratios: readonly number[]): Money[] {
    if (ratios.length === 0) {
      throw new InvalidAmountError('allocate requires at least one ratio');
    }
    if (ratios.some((r) => !Number.isSafeInteger(r) || r < 0)) {
      throw new InvalidAmountError('allocate ratios must be non-negative integers');
    }
    const total = ratios.reduce((acc, r) => acc + BigInt(r), 0n);
    if (total === 0n) {
      throw new InvalidAmountError('allocate ratios must not all be zero');
    }
    const shares = ratios.map((r) => (this.amount * BigInt(r)) / total);
    let remainder = this.amount - shares.reduce((acc, s) => acc + s, 0n);
    const step = remainder < 0n ? -1n : 1n;
    for (let i = 0; remainder !== 0n; i = (i + 1) % shares.length) {
      shares[i]! += step;
      remainder -= step;
    }
    return shares.map((s) => new Money(s, this.currency));
  }

  /** Representacion en unidad mayor, p.ej. 1025n USD => "10.25". */
  toDecimalString(): string {
    const exponent = currencyExponent(this.currency);
    const negative = this.amount < 0n;
    const abs = negative ? -this.amount : this.amount;
    const digits = abs.toString().padStart(exponent + 1, '0');
    const whole = digits.slice(0, digits.length - exponent) || '0';
    const frac = exponent > 0 ? `.${digits.slice(digits.length - exponent)}` : '';
    return `${negative ? '-' : ''}${whole}${frac}`;
  }

  /** Serializacion segura: el monto viaja como string para no perder precision. */
  toJSON(): { amount: string; currency: CurrencyCode } {
    return { amount: this.amount.toString(), currency: this.currency };
  }

  toString(): string {
    return `${this.currency} ${this.toDecimalString()}`;
  }
}
