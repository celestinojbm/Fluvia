import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';

/**
 * BFF del asistente del COMPRADOR (checkout y seguimiento del pedido).
 *  - La credencial (sesión de checkout + client_secret, o token de
 *    seguimiento) se valida contra la API y se guarda en una cookie httpOnly
 *    con ruta propia `/api/asistente/<clave>`: dos pestañas de pedidos
 *    distintos no se pisan y el navegador nunca la lee desde JS.
 *  - Solo rutas de una lista cerrada; mutaciones con guarda CSRF (cabecera
 *    no-simple + mismo origen); respuestas en streaming sin almacenar.
 *  - Sin cookie o credencial vencida: 401 con el código del catálogo.
 */
export const API = process.env.FLUVIA_API_URL ?? 'http://127.0.0.1:3000';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{20,64}$/;
// client_secret: `cs_` + base64url (incluye «-» y «_»).
const SECRET = /^[A-Za-z0-9_-]{8,200}$/;

export type BuyerCredential =
  { kind: 'checkout'; sessionId: string; secret: string } | { kind: 'tracking'; token: string };

export function parseCredential(v: unknown): BuyerCredential | null {
  const o = v as Record<string, unknown> | null;
  if (o && typeof o.checkout_session_id === 'string' && typeof o.client_secret === 'string') {
    if (UUID.test(o.checkout_session_id) && SECRET.test(o.client_secret)) {
      return { kind: 'checkout', sessionId: o.checkout_session_id, secret: o.client_secret };
    }
  }
  if (o && typeof o.tracking_token === 'string' && TOKEN.test(o.tracking_token)) {
    return { kind: 'tracking', token: o.tracking_token };
  }
  return null;
}

export function credentialHeaders(c: BuyerCredential): Record<string, string> {
  return c.kind === 'checkout'
    ? { 'x-buyer-checkout': c.sessionId, 'x-checkout-client-secret': c.secret }
    : { 'x-buyer-tracking': c.token };
}

export const keyOf = (c: BuyerCredential) =>
  createHash('sha256')
    .update(c.kind === 'checkout' ? `c:${c.sessionId}:${c.secret}` : `t:${c.token}`)
    .digest('hex')
    .slice(0, 24);

export const cookieName = (key: string) => `fluvia_buyer_${key}`;

export function encodeCredential(c: BuyerCredential): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}
export function decodeCredential(v: string | undefined): BuyerCredential | null {
  if (!v) return null;
  try {
    const o = JSON.parse(Buffer.from(v, 'base64url').toString()) as BuyerCredential;
    if (o.kind === 'checkout' && UUID.test(o.sessionId) && SECRET.test(o.secret)) return o;
    if (o.kind === 'tracking' && TOKEN.test(o.token)) return o;
  } catch {
    /* ilegible */
  }
  return null;
}

/** Mutaciones solo desde esta misma página (cabecera no-simple + origen). */
export function rejectCrossSite(req: Request): NextResponse | null {
  const site = req.headers.get('sec-fetch-site');
  const origin = req.headers.get('origin');
  const host = req.headers.get('host');
  const sameOrigin =
    (site === null || site === 'same-origin') &&
    (origin === null || (host !== null && new URL(origin).host === host));
  if (req.headers.get('x-fluvia-csrf') !== '1' || !sameOrigin) {
    return NextResponse.json({ error: { code: 'origin_not_allowed' } }, { status: 403 });
  }
  return null;
}

export const ALLOWED: Array<{ re: RegExp; methods: Array<'GET' | 'POST'> }> = [
  { re: /^status$/, methods: ['GET'] },
  { re: /^conversations$/, methods: ['GET', 'POST'] },
  { re: /^conversations\/[0-9a-f-]{36}\/messages$/, methods: ['GET', 'POST'] },
  { re: /^attachments$/, methods: ['POST'] },
  { re: /^attachments\/[0-9a-f-]{36}\/delete$/, methods: ['POST'] },
  { re: /^attachments\/[0-9a-f-]{36}\/content$/, methods: ['GET'] },
  { re: /^transcriptions$/, methods: ['POST'] },
  { re: /^speech$/, methods: ['POST'] },
  { re: /^call\/token$/, methods: ['POST'] },
];
