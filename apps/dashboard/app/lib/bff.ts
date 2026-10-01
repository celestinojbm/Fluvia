import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { apiBase } from './api';
import { assertTrustedMutationRequest } from './csrf';

/**
 * BFF genérico de la plataforma del comercio. Para cada llamada:
 *  1. Mutaciones: guard CSRF same-origin estricto ANTES de leer cookie/body.
 *  2. Sin cookie de sesión ⇒ 401 (la UI ofrece volver a iniciar sesión).
 *  3. Ids de la ruta validados como UUID (sin inyección de path).
 *  4. Reenvía con Bearer y, si se pide, PROPAGA la `Idempotency-Key` del
 *     cliente (obligatoria): un reintento tras resultado incierto no duplica.
 *  5. Status y cuerpo (sobre de error del catálogo con su `code`) TAL CUAL.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validIds(...ids: string[]): boolean {
  return ids.every((id) => UUID_RE.test(id));
}

export async function forward(
  req: Request,
  method: 'GET' | 'POST' | 'PATCH',
  apiPath: string,
  opts: { idempotent?: boolean } = {}
): Promise<NextResponse> {
  if (method !== 'GET') {
    const rejected = assertTrustedMutationRequest(req);
    if (rejected) return rejected;
  }
  const token = (await cookies()).get('fluvia_session')?.value;
  if (!token) {
    return NextResponse.json({ error: { code: 'invalid_session' } }, { status: 401 });
  }
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (opts.idempotent) {
    const key = req.headers.get('idempotency-key');
    if (!key) return NextResponse.json({ error: { code: 'validation_error' } }, { status: 400 });
    headers['idempotency-key'] = key;
  }
  let body: string | undefined;
  if (method !== 'GET') {
    body = await req.text();
    headers['content-type'] = 'application/json';
  }
  let res: Response;
  try {
    res = await fetch(`${apiBase()}${apiPath}`, { method, headers, body, cache: 'no-store' });
  } catch {
    return NextResponse.json({ error: { code: 'upstream_unavailable' } }, { status: 502 });
  }
  const text = await res.text();
  return new NextResponse(text, {
    status: res.status,
    headers: { 'content-type': 'application/json' },
  });
}

export const badRequest = () =>
  NextResponse.json({ error: { code: 'not_found' } }, { status: 404 });
