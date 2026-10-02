import { NextResponse } from 'next/server';
import {
  API,
  cookieName,
  credentialHeaders,
  encodeCredential,
  keyOf,
  parseCredential,
  rejectCrossSite,
} from '../buyer-bff';

/**
 * Registra la credencial del comprador para el asistente de ESTA página.
 * Antes de guardarla la valida contra la API: vencida o inválida ⇒ el mismo
 * 401 del catálogo y ninguna cookie.
 */
export async function POST(req: Request) {
  const rejected = rejectCrossSite(req);
  if (rejected) return rejected;
  const cred = parseCredential(await req.json().catch(() => null));
  if (!cred) {
    return NextResponse.json({ error: { code: 'buyer_session_invalid' } }, { status: 401 });
  }
  let res: Response;
  try {
    res = await fetch(`${API}/v1/buyer/assistant/status`, {
      headers: credentialHeaders(cred),
      cache: 'no-store',
    });
  } catch {
    return NextResponse.json({ error: { code: 'upstream_unavailable' } }, { status: 502 });
  }
  if (!res.ok) {
    return new NextResponse(await res.text(), {
      status: res.status,
      headers: { 'content-type': 'application/json' },
    });
  }
  const key = keyOf(cred);
  const out = NextResponse.json({ base: `/api/asistente/${key}`, status: await res.json() });
  out.cookies.set(cookieName(key), encodeCredential(cred), {
    httpOnly: true,
    sameSite: 'strict',
    secure: new URL(req.url).protocol === 'https:',
    path: `/api/asistente/${key}`,
    maxAge: 24 * 60 * 60,
  });
  out.headers.set('cache-control', 'no-store');
  return out;
}
