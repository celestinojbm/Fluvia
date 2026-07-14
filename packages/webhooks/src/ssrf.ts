import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Guard SSRF de webhooks salientes (webhook-delivery.md §4, OBLIGATORIO
 * antes del primer delivery real):
 *  - HTTPS obligatorio (HTTP solo cuando allowPrivateNetworks, i.e. local).
 *  - Puertos: 443 (y 80 solo local).
 *  - Se resuelven TODAS las IPs (v4/v6) y todas deben ser publicas.
 *  - El deliverer CONECTA a la IP validada (pinning anti DNS-rebinding) y
 *    re-valida en cada intento; la IP queda registrada en webhook_attempts.
 *  - Sin redirects: cualquier 3xx es fallo del intento.
 */

export class UnsafeWebhookUrlError extends Error {
  constructor(url: string, reason: string) {
    // RA-F65B-EXT-001: el mensaje viaja a logs y a webhook_events.last_error /
    // webhook_attempts.error (serializados en list/detail), así que JAMÁS debe
    // contener userinfo, query ni fragment de la URL rechazada.
    super(`Webhook URL rejected (${reason}): ${sanitizeUrlForDisplay(url)}`);
    this.name = 'UnsafeWebhookUrlError';
  }
}

/**
 * Representación de una URL segura para logs/errores/UI (RA-F65B-EXT-001):
 * conserva scheme+host+path (necesarios para diagnosticar) y REDACTA userinfo,
 * query y fragment, que pueden portar credenciales.
 */
export function sanitizeUrlForDisplay(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return '[unparseable URL]';
  }
  const cred = url.username !== '' || url.password !== '' ? '[REDACTED]@' : '';
  const query = url.search !== '' ? '?[REDACTED]' : '';
  const fragment = url.hash !== '' ? '#[REDACTED]' : '';
  return `${url.protocol}//${cred}${url.host}${url.pathname}${query}${fragment}`;
}

/**
 * Metadata SEGURA de una URL de webhook para resúmenes de auditoría
 * (RA-F65B-EXT-001): la auditoría jamás copia la URL cruda (podría funcionar
 * como credencial). `url_host` permite revisar el destino; `url_fingerprint`
 * (SHA-256 de la URL exacta, irreversible) permite correlacionar/verificar un
 * destino conocido sin revelarlo.
 */
export function webhookUrlAuditMetadata(rawUrl: string): {
  url_host: string;
  url_fingerprint: string;
} {
  const fingerprint = createHash('sha256').update(rawUrl, 'utf8').digest('hex');
  let host = '[unparseable]';
  try {
    host = new URL(rawUrl).host;
  } catch {
    /* URL no parseable: host placeholder, fingerprint sigue siendo útil */
  }
  return { url_host: host, url_fingerprint: `sha256:${fingerprint}` };
}

/**
 * Denylist de NOMBRES de parámetro de query que portan credenciales
 * (RA-F65B-EXT-001). Se compara por SEGMENTOS del nombre (separadores `-_.` y
 * camelCase), no por regex sobre la URL cruda: `api_key`, `apiKey`, `API-KEY`
 * y `access_token` caen igual; `keyword`/`author`/`signal` NO dan falso
 * positivo. Complementada con substrings fuertes sobre el nombre colapsado
 * (p. ej. `accesstoken`, `clientsecret` sin separadores).
 */
const SENSITIVE_QUERY_SEGMENTS = new Set([
  'token',
  'secret',
  'secrets',
  'password',
  'passwd',
  'pwd',
  'auth',
  'authorization',
  'signature',
  'sig',
  'key',
  'keys',
  'apikey',
  'credential',
  'credentials',
  'bearer',
]);
const SENSITIVE_COLLAPSED_SUBSTRINGS = [
  'token',
  'secret',
  'password',
  'passwd',
  'credential',
  'signature',
  'apikey',
  'accesskey',
];

function isSensitiveParamName(name: string): boolean {
  const segments = name
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2') // camelCase → palabras
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
  if (segments.some((s) => SENSITIVE_QUERY_SEGMENTS.has(s))) return true;
  const collapsed = segments.join('');
  return SENSITIVE_COLLAPSED_SUBSTRINGS.some((s) => collapsed.includes(s));
}

/**
 * Busca material de credencial en la query string. Doble parseo estructurado
 * (no una regex débil): `URLSearchParams` (decodifica percent-encoding y
 * recorre TODOS los duplicados) + split manual por `&`/`;` (separador legado
 * que URLSearchParams no divide). Un nombre indecodificable se trata como
 * sensible (fail-closed). Devuelve el NOMBRE ofensor (nunca el valor).
 */
function findSensitiveQueryParam(url: URL): string | null {
  for (const [name] of url.searchParams) {
    if (isSensitiveParamName(name)) return name;
  }
  for (const part of url.search.replace(/^\?/u, '').split(/[&;]/u)) {
    if (!part) continue;
    const rawName = part.split('=')[0]!;
    let name: string;
    try {
      name = decodeURIComponent(rawName.replace(/\+/gu, ' '));
    } catch {
      return rawName; // percent-encoding roto: sospechoso, fail-closed
    }
    if (isSensitiveParamName(name)) return name;
  }
  return null;
}

/**
 * Expande una IPv6 (ya validada por `isIP`) a sus 16 bytes canónicos, incluida la
 * compresión `::` y un IPv4 embebido en notación con puntos (`::ffff:1.2.3.4`).
 * Devuelve null si no parsea. Trabajar sobre bytes es lo que hace la denylist
 * robusta: comparar por STRING deja pasar formas equivalentes no canónicas
 * (`0:0:0:0:0:0:0:1`, `::ffff:7f00:1`, el resto del rango `fe80::/10`, etc.).
 */
function ipv6ToBytes(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);

  // IPv4 embebido en notación con puntos → convertir el último cuarteto a 2 hextets.
  if (s.includes('.')) {
    const lastColon = s.lastIndexOf(':');
    if (lastColon === -1) return null;
    const quad = s
      .slice(lastColon + 1)
      .split('.')
      .map(Number);
    if (quad.length !== 4 || quad.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
      return null;
    const hi = ((quad[0]! << 8) | quad[1]!).toString(16);
    const lo = ((quad[2]! << 8) | quad[3]!).toString(16);
    s = `${s.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;
  let groups: string[];
  if (tail === null) {
    groups = head;
  } else {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...Array<string>(missing).fill('0'), ...tail];
  }
  if (groups.length !== 8) return null;

  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const v = parseInt(g, 16);
    bytes.push((v >> 8) & 0xff, v & 0xff);
  }
  return bytes;
}

export function isPrivateIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    if (a === 0 || a === 10 || a === 127) return true; // this-net, RFC1918, loopback
    if (a === 100 && b! >= 64 && b! <= 127) return true; // CGNAT 100.64/10
    if (a === 169 && b === 254) return true; // link-local / metadata
    if (a === 172 && b! >= 16 && b! <= 31) return true; // RFC1918
    if (a === 192 && b === 168) return true; // RFC1918
    if (a >= 224) return true; // multicast + reservado
    return false;
  }
  if (family === 6) {
    const b = ipv6ToBytes(ip);
    if (!b) return true; // IPv6 no parseable ⇒ rechazar por defecto
    const z10 = b.slice(0, 10).every((x) => x === 0);
    // v4-mapped ::ffff:a.b.c.d → evaluar el IPv4 embebido con la denylist v4.
    if (z10 && b[10] === 0xff && b[11] === 0xff) return isPrivateIp(b.slice(12).join('.'));
    if (b.every((x) => x === 0)) return true; // unspecified ::
    if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return true; // loopback ::1
    // v4-compatible ::a.b.c.d (obsoleto) con IPv4 embebido no trivial → evaluarlo.
    if (z10 && b[10] === 0 && b[11] === 0 && !(b[12] === 0 && b[13] === 0 && b[14] === 0)) {
      return isPrivateIp(b.slice(12).join('.'));
    }
    if ((b[0]! & 0xfe) === 0xfc) return true; // ULA fc00::/7 (fc/fd)
    if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return true; // link-local fe80::/10
    if (b[0] === 0xff) return true; // multicast ff00::/8
    return false;
  }
  return true; // no es una IP: rechazar por defecto
}

export interface SafeWebhookTarget {
  protocol: 'https:' | 'http:';
  hostname: string;
  port: number;
  path: string;
  /** IP validada primaria a la que se conecta (pinning). */
  ip: string;
  /**
   * TODAS las IPs validadas de la resolucion (V2-N2): ante error de CONEXION
   * el deliverer puede hacer failover a las demas sin re-resolver (cada una ya
   * paso la denylist; re-resolver aqui reabriria la ventana de rebinding).
   */
  ips: readonly string[];
}

export interface SsrfGuardOptions {
  /** SOLO local/test (forzado por config): permite redes privadas y HTTP. */
  allowPrivateNetworks?: boolean;
  /** Inyectable para tests deterministas. */
  resolve?: (hostname: string) => Promise<string[]>;
}

/** Validacion estatica de la URL (se usa tambien al REGISTRAR el endpoint). */
export function assertSafeWebhookUrl(rawUrl: string, opts: SsrfGuardOptions = {}): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeWebhookUrlError(rawUrl, 'malformed URL');
  }
  const allowPrivate = opts.allowPrivateNetworks ?? false;
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) {
    throw new UnsafeWebhookUrlError(rawUrl, 'https required');
  }
  if (url.username || url.password) {
    throw new UnsafeWebhookUrlError(rawUrl, 'credentials in URL');
  }
  // RA-F65B-EXT-001: una URL con material de credencial NO se acepta (ni se
  // "sanitiza" en silencio: cambiar el destino que el usuario escribió está
  // prohibido). Aplica en el registro Y en cada intento de entrega (este guard
  // corre en ambos): una fila legada con `?token=…` deja de entregarse
  // (fail-closed) con un error que no revela el secreto.
  if (url.hash !== '') {
    throw new UnsafeWebhookUrlError(rawUrl, 'fragment not allowed');
  }
  const sensitiveParam = findSensitiveQueryParam(url);
  if (sensitiveParam !== null) {
    throw new UnsafeWebhookUrlError(
      rawUrl,
      `credential-bearing query parameter "${sensitiveParam}" not allowed`
    );
  }
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  const allowedPorts = allowPrivate ? null : new Set([443]);
  if (allowedPorts && !allowedPorts.has(port)) {
    throw new UnsafeWebhookUrlError(rawUrl, `port ${port} not allowed`);
  }
  return url;
}

/** Resuelve y valida TODAS las IPs; devuelve el destino pineado. */
export async function resolveSafeWebhookTarget(
  rawUrl: string,
  opts: SsrfGuardOptions = {}
): Promise<SafeWebhookTarget> {
  const url = assertSafeWebhookUrl(rawUrl, opts);
  const allowPrivate = opts.allowPrivateNetworks ?? false;
  const hostname = url.hostname.replace(/^\[|\]$/g, '');

  let ips: string[];
  if (isIP(hostname)) {
    ips = [hostname];
  } else if (opts.resolve) {
    ips = await opts.resolve(hostname);
  } else {
    const results = await lookup(hostname, { all: true, verbatim: true });
    ips = results.map((r) => r.address);
  }
  if (ips.length === 0) throw new UnsafeWebhookUrlError(rawUrl, 'DNS resolved no addresses');
  if (!allowPrivate) {
    for (const ip of ips) {
      if (isPrivateIp(ip)) {
        throw new UnsafeWebhookUrlError(rawUrl, `resolves to non-public address ${ip}`);
      }
    }
  }
  return {
    protocol: url.protocol as 'https:' | 'http:',
    hostname,
    port: url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80,
    path: `${url.pathname}${url.search}`,
    ip: ips[0]!,
    ips,
  };
}
