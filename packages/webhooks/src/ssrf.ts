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
    super(`Webhook URL rejected (${reason}): ${url}`);
    this.name = 'UnsafeWebhookUrlError';
  }
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
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true; // loopback / unspecified
    if (lower.startsWith('fe80')) return true; // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA
    if (lower.startsWith('ff')) return true; // multicast
    if (lower.startsWith('::ffff:')) return isPrivateIp(lower.slice(7)); // v4-mapped
    return false;
  }
  return true; // no es una IP: rechazar por defecto
}

export interface SafeWebhookTarget {
  protocol: 'https:' | 'http:';
  hostname: string;
  port: number;
  path: string;
  /** IP validada a la que se conecta (pinning). */
  ip: string;
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
  };
}
