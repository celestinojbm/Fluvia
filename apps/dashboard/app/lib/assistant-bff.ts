import { NextResponse } from 'next/server';
import { apiBase } from './api';
import { assertTrustedMutationRequest } from './csrf';

/**
 * BFF del asistente (Personal y Comercio). No es un proxy abierto:
 *  - solo rutas de una lista cerrada;
 *  - mutaciones con la guarda CSRF del panel;
 *  - el token sale de la cookie httpOnly (el navegador nunca lo ve);
 *  - respuestas en STREAMING (SSE, audio) sin almacenar; la cancelación del
 *    navegador se propaga a la API (signal) para cortar al proveedor.
 */
const ALLOWED: Array<{ re: RegExp; methods: Array<'GET' | 'POST'> }> = [
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

const PASS_RESPONSE_HEADERS = ['content-type', 'x-fluvia-simulated', 'content-disposition'];

export async function forwardAssistant(
  req: Request,
  method: 'GET' | 'POST',
  segments: string[],
  upstreamBase: string,
  token: string | null,
  invalidCode: string
): Promise<Response> {
  if (method === 'POST') {
    const rejected = assertTrustedMutationRequest(req);
    if (rejected) return rejected;
  }
  const path = segments.join('/');
  const rule = ALLOWED.find((r) => r.re.test(path));
  if (!rule || !rule.methods.includes(method)) {
    return NextResponse.json({ error: { code: 'not_found' } }, { status: 404 });
  }
  if (!token) return NextResponse.json({ error: { code: invalidCode } }, { status: 401 });

  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  let body: BodyInit | undefined;
  if (method === 'POST') {
    if (path === 'attachments') {
      const kind = req.headers.get('x-attachment-kind');
      if (kind !== 'image' && kind !== 'audio') {
        return NextResponse.json({ error: { code: 'validation_error' } }, { status: 400 });
      }
      headers['content-type'] = 'application/octet-stream';
      headers['x-attachment-kind'] = kind;
      body = await req.arrayBuffer();
    } else {
      const text = await req.text();
      if (text) {
        headers['content-type'] = 'application/json';
        body = text;
      }
    }
  }
  let res: Response;
  try {
    res = await fetch(`${apiBase()}${upstreamBase}/${path}`, {
      method,
      headers,
      body,
      cache: 'no-store',
      signal: req.signal,
    });
  } catch {
    return NextResponse.json({ error: { code: 'upstream_unavailable' } }, { status: 502 });
  }
  const out = new Headers({ 'cache-control': 'no-store' });
  for (const h of PASS_RESPONSE_HEADERS) {
    const v = res.headers.get(h);
    if (v) out.set(h, v);
  }
  if (out.get('content-type')?.startsWith('text/event-stream')) out.set('x-accel-buffering', 'no');
  return new Response(res.body, { status: res.status, headers: out });
}
