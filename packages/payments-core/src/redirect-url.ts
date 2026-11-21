/**
 * URLs de retorno del checkout (`success_url` / `cancel_url`).
 *
 * El comercio las provee y la página alojada termina navegando a ellas. Un
 * esquema distinto de http/https (`javascript:`, `data:`, `vbscript:`, `file:`…)
 * convertiría esa navegación en ejecución de script en el origen del checkout
 * (XSS), así que solo se admiten URLs absolutas http(s).
 *
 * Reglas (todas deben cumplirse):
 *  - Cadena sin espacios ni caracteres de control. El parser WHATWG los descarta
 *    en silencio (`java\tscript:` → `javascript:`), así que lo que se guarda debe
 *    ser exactamente lo que el navegador interpreta.
 *  - Empieza literalmente por `http://` o `https://` (sin mayúsculas/minúsculas)
 *    y parsea como URL absoluta con ese esquema. El prefijo literal evita formas
 *    que WHATWG "repara" (`http:/x`, `https:\\x`) y que otro parser leería distinto.
 *  - Tiene host.
 *  - Sin credenciales embebidas (`https://user:pass@host`), que se prestan a
 *    disfrazar el destino real ante el comprador.
 *  - Máximo {@link MAX_REDIRECT_URL_LENGTH} caracteres.
 *
 * La validación ocurre al crear (API + servicio) y también al LEER (vista
 * alojada / DTO): una fila antigua guardada antes de esta regla nunca vuelve a
 * salir de la API con un esquema peligroso.
 */

export const MAX_REDIRECT_URL_LENGTH = 2000;

const ALLOWED_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

const HTTP_PREFIX = /^https?:\/\//i;

// Espacios (incluye \t \n \r, NBSP, separadores Unicode) y controles C0/C1/DEL.
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARS = /[\s\u0000-\u001F\u007F-\u009F]/u;

export function isSafeRedirectUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > MAX_REDIRECT_URL_LENGTH) return false;
  if (FORBIDDEN_CHARS.test(value)) return false;
  if (!HTTP_PREFIX.test(value)) return false;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) return false;
  if (parsed.hostname === '') return false;
  if (parsed.username !== '' || parsed.password !== '') return false;
  return true;
}

/** Para salidas: devuelve la URL solo si es segura; si no, `null`. */
export function safeRedirectUrlOrNull(value: string | null | undefined): string | null {
  return isSafeRedirectUrl(value) ? value : null;
}

export const REDIRECT_URL_RULE_MESSAGE =
  'Must be an absolute http(s) URL without credentials, whitespace or control characters';
