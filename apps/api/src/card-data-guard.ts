/**
 * TM-06 (threat model §5) — guard de datos de tarjeta (PCI, `pci-scope.md` §3).
 *
 * Fluvia es SAQ A-like: el backend JAMÁS ve PAN/CVV — solo tokens opacos del
 * proveedor (`tok_…`). Este guard hace cumplir esa frontera en el borde HTTP:
 * si un request trae una estructura que APARENTA datos primarios de tarjeta,
 * se RECHAZA (422 `card_data_not_allowed`) antes de validar/procesar nada, con
 * un log de incidente que NUNCA incluye el valor (solo la ruta del campo).
 *
 * Heurística CONSERVADORA (pocos falsos positivos, y sin pretender que un
 * blocklist "resuelve PCI" — el doc lo aclara):
 *  - `pan_value`: cualquier valor string/number que, quitando espacios y
 *    guiones, tenga 13–19 dígitos, empiece por un IIN conocido de marca
 *    (Visa/MC/Amex/Discover/Diners/JCB) Y pase Luhn. El prefijo de marca
 *    excluye timestamps epoch-ms (empiezan por 1) y consecutivos triviales.
 *  - `pan_field`: un campo cuyo NOMBRE normalizado es inequívocamente de
 *    tarjeta (`card_number`, `pan`, …) con un valor de 12–19 dígitos (aquí el
 *    nombre ya es condenatorio; no se exige Luhn).
 *  - `cvv_field`: un campo con nombre de código de seguridad (`cvv`, `cvc`, …)
 *    y valor de 3–4 dígitos.
 *
 * El recorrido del body está acotado (profundidad/nodos) para que un payload
 * hostil no lo convierta en un vector de DoS. Los bodies no-objeto (p. ej. la
 * ingesta del webhook del proveedor, que parsea como string firmado) no pasan
 * por aquí.
 */

export type CardDataKind = 'pan_value' | 'pan_field' | 'cvv_field';

export interface CardDataFinding {
  /** Ruta del campo (p. ej. `metadata.card_number`) — JAMÁS el valor. */
  path: string;
  kind: CardDataKind;
}

const MAX_DEPTH = 8;
const MAX_NODES = 2000;

/** Nombres de campo inequívocos de PAN (normalizados: minúsculas, sin _-. ni espacios). */
const PAN_FIELD_NAMES = new Set([
  'cardnumber',
  'ccnumber',
  'ccnum',
  'cardno',
  'pan',
  'cardpan',
  'creditcard',
  'creditcardnumber',
  'debitcardnumber',
  'numerotarjeta',
  'numerodetarjeta',
  'numtarjeta',
]);

/** Nombres de campo de código de seguridad. */
const CVV_FIELD_NAMES = new Set([
  'cvv',
  'cvc',
  'cvv2',
  'cvc2',
  'csc',
  'securitycode',
  'cardsecuritycode',
  'cardverificationvalue',
  'cardverificationcode',
  'codigoseguridad',
  'codigodeseguridad',
]);

/**
 * IINs de marca conocidos: Visa (4), Mastercard (51–55, 2221–2720), Amex
 * (34/37), Discover (6011, 644–649, 65), Diners (300–305, 36, 38, 39), JCB (35).
 */
const KNOWN_IIN_RE =
  /^(4|5[1-5]|22[2-9]\d|2[3-6]\d\d|27[01]\d|2720|3[47]|6011|64[4-9]|65|30[0-5]|3[689]|35)/;

export function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function digitsOf(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  // Los PAN suelen viajar formateados ("4111 1111 1111 1111", "5500-0000-…").
  const stripped = value.replace(/[\s-]/g, '');
  return /^\d+$/.test(stripped) ? stripped : null;
}

/** ¿El valor APARENTA un PAN? 13–19 dígitos + IIN de marca + Luhn. */
export function looksLikePan(value: unknown): boolean {
  const digits = digitsOf(value);
  if (digits === null || digits.length < 13 || digits.length > 19) return false;
  return KNOWN_IIN_RE.test(digits) && luhnValid(digits);
}

function normalizeFieldName(name: string): string {
  return name.toLowerCase().replace(/[\s_.-]/g, '');
}

/**
 * Busca datos de tarjeta en un body ya parseado. Devuelve el PRIMER hallazgo
 * (ruta + tipo, jamás el valor) o null. Recorrido acotado: profundidad y
 * número de nodos limitados — un body hostil no puede volver esto cuadrático.
 */
export function findCardData(body: unknown): CardDataFinding | null {
  let nodes = 0;

  const walk = (value: unknown, path: string, depth: number): CardDataFinding | null => {
    if (nodes >= MAX_NODES || depth > MAX_DEPTH) return null;
    nodes += 1;

    if (typeof value === 'string' || typeof value === 'number') {
      if (looksLikePan(value)) return { path, kind: 'pan_value' };
      return null;
    }
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        const hit = walk(value[i], `${path}[${i}]`, depth + 1);
        if (hit) return hit;
      }
      return null;
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        const childPath = path === '' ? key : `${path}.${key}`;
        const normalized = normalizeFieldName(key);
        const digits = digitsOf(child);
        if (
          PAN_FIELD_NAMES.has(normalized) &&
          digits !== null &&
          digits.length >= 12 &&
          digits.length <= 19
        ) {
          return { path: childPath, kind: 'pan_field' };
        }
        if (
          CVV_FIELD_NAMES.has(normalized) &&
          digits !== null &&
          digits.length >= 3 &&
          digits.length <= 4
        ) {
          return { path: childPath, kind: 'cvv_field' };
        }
        const hit = walk(child, childPath, depth + 1);
        if (hit) return hit;
      }
      return null;
    }
    return null;
  };

  return walk(body, '', 0);
}
