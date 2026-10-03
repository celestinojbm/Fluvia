import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as tlsConnect, rootCertificates } from 'node:tls';
import { fileURLToPath } from 'node:url';

/**
 * GET HTTPS con verificación TLS COMPLETA (nunca se desactiva):
 *  - raíces del sistema + NODE_EXTRA_CA_CERTS (si existe) + el intermedio
 *    público de Sectigo que www.bcv.org.ve no envía (cadena incompleta del
 *    servidor; ver ca/sectigo-dv-r36.pem);
 *  - proxy HTTP CONNECT si HTTPS_PROXY está definido (sin tocar NO_PROXY).
 * Límites: tiempo máximo y tamaño máximo de respuesta.
 */
const INTERMEDIATES = [
  readFileSync(fileURLToPath(new URL('./ca/sectigo-dv-r36.pem', import.meta.url)), 'utf8'),
];

function extraCa(): string[] {
  const f = process.env.NODE_EXTRA_CA_CERTS;
  if (!f) return [];
  try {
    return [readFileSync(f, 'utf8')];
  } catch {
    return [];
  }
}

export const CA_BUNDLE = [...rootCertificates, ...extraCa(), ...INTERMEDIATES];

export interface HttpResult {
  status: number;
  body: Buffer;
  contentType: string;
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

function noProxy(host: string): boolean {
  const list = (process.env.NO_PROXY ?? process.env.no_proxy ?? '').split(',').map((s) => s.trim());
  return list.some(
    (p) => p && (host === p || (p.startsWith('.') && host.endsWith(p)) || host.endsWith(`.${p}`))
  );
}

export type FetchLike = (
  url: string,
  opts: { headers?: Record<string, string>; timeoutMs: number; maxBytes: number }
) => Promise<HttpResult>;

export const httpsGet: FetchLike = (url, opts) =>
  new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== 'https:') return reject(new HttpError('solo https'));
    const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
    const timer = setTimeout(() => reject(new HttpError('tiempo agotado')), opts.timeoutMs);
    const finish = (fn: () => void) => {
      clearTimeout(timer);
      fn();
    };
    const doRequest = (socket?: import('node:net').Socket) => {
      const req = httpsRequest(
        {
          host: u.hostname,
          port: u.port || 443,
          path: `${u.pathname}${u.search}`,
          method: 'GET',
          headers: { 'user-agent': 'Fluvia-FX/1.0 (+referencias publicas)', ...opts.headers },
          ca: CA_BUNDLE,
          servername: u.hostname,
          ...(socket
            ? {
                createConnection: () =>
                  tlsConnect({ socket, servername: u.hostname, ca: CA_BUNDLE }),
              }
            : {}),
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (c: Buffer) => {
            size += c.length;
            if (size > opts.maxBytes) {
              req.destroy();
              finish(() => reject(new HttpError('respuesta demasiado grande')));
              return;
            }
            chunks.push(c);
          });
          res.on('end', () =>
            finish(() =>
              resolve({
                status: res.statusCode ?? 0,
                body: Buffer.concat(chunks),
                contentType: String(res.headers['content-type'] ?? ''),
              })
            )
          );
          res.on('error', (e) => finish(() => reject(new HttpError(e.message))));
        }
      );
      req.on('error', (e) => finish(() => reject(new HttpError(e.message))));
      req.end();
    };
    if (!proxy || noProxy(u.hostname)) return doRequest();
    const p = new URL(proxy);
    const connectReq = httpRequest({
      host: p.hostname,
      port: p.port || 80,
      method: 'CONNECT',
      path: `${u.hostname}:${u.port || 443}`,
      headers: { host: `${u.hostname}:${u.port || 443}` },
    });
    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return finish(() =>
          reject(new HttpError(`proxy respondió ${res.statusCode}`, res.statusCode))
        );
      }
      doRequest(socket);
    });
    connectReq.on('error', (e) => finish(() => reject(new HttpError(e.message))));
    connectReq.end();
  });
