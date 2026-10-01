import { NextResponse } from 'next/server';

/**
 * Proxy server-side común del checkout: reenvía el `client_secret` (header) a
 * la API; el navegador nunca conoce su URL. Status y cuerpo tal cual; sin
 * respuesta de la API ⇒ 502 (la UI lo trata como resultado incierto).
 */
const API = process.env.FLUVIA_API_URL ?? 'http://127.0.0.1:3000';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function proxyCheckout(
  req: Request,
  id: string,
  path: string,
  method: 'GET' | 'POST'
): Promise<NextResponse> {
  if (!UUID_RE.test(id)) return NextResponse.json({ error: { code: 'not_found' } }, { status: 404 });
  const secret = req.headers.get('x-checkout-client-secret') ?? '';
  const headers: Record<string, string> = { 'x-checkout-client-secret': secret };
  let body: string | undefined;
  if (method === 'POST') {
    body = await req.text();
    headers['content-type'] = 'application/json';
  }
  let res: Response;
  try {
    res = await fetch(`${API}/v1/checkout_sessions/${id}${path}`, {
      method,
      headers,
      body,
      cache: 'no-store',
    });
  } catch {
    return NextResponse.json({ error: { code: 'upstream_unavailable' } }, { status: 502 });
  }
  return new NextResponse(await res.text(), {
    status: res.status,
    headers: { 'content-type': 'application/json' },
  });
}
