import { NextResponse } from 'next/server';
import { apiBase } from '../../../lib/api';
import { assertTrustedMutationRequest } from '../../../lib/csrf';
import { personalToken } from '../../../personal/lib/server';

/**
 * BFF de Fluvia Personal: reenvía a `/v1/personal/<ruta>` con la sesión del
 * cliente. Ruta acotada a una lista de prefijos conocidos y segmentos seguros
 * (sin `..`, sin caracteres de control): no es un proxy abierto. Mutaciones:
 * guard CSRF antes de leer cookie/body y `Idempotency-Key` propagada.
 */
const ALLOWED = [
  /^wallet\/(balances|statement|fundings|transfers|withdrawals)$/,
  /^collateral\/(lock|release)$/,
  /^credit(\/(applications|plans|repayments))?$/,
  /^credit\/plans\/[0-9a-f-]{36}$/,
  /^cards$/,
  /^cards\/[0-9a-f-]{36}(\/(activate|block|unblock|close|replace|limits|reveal))?$/,
  /^offers\/installments$/,
  /^payment-codes$/,
  /^purchases(\/[0-9a-f-]{36})?$/,
  /^(me|overview)$/,
  // Tiendas Fluvia (plano del cliente).
  /^shop\/(stores|search|featured|favorites|cart|cart\/items|orders)$/,
  /^shop\/stores\/[a-z0-9-]{3,48}(\/products\/[0-9a-f-]{36})?$/,
  /^shop\/orders\/[0-9a-f-]{36}(\/(cancel|return|pay|checkout))?$/,
];

async function handle(req: Request, method: 'GET' | 'POST', segments: string[]) {
  if (method === 'POST') {
    const rejected = assertTrustedMutationRequest(req);
    if (rejected) return rejected;
  }
  const path = segments.join('/');
  if (!ALLOWED.some((re) => re.test(path))) {
    return NextResponse.json({ error: { code: 'not_found' } }, { status: 404 });
  }
  const token = await personalToken();
  if (!token)
    return NextResponse.json({ error: { code: 'consumer_session_invalid' } }, { status: 401 });
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  const key = req.headers.get('idempotency-key');
  if (key) headers['idempotency-key'] = key;
  let body: string | undefined;
  if (method === 'POST') {
    // Fastify rechaza (400) un JSON vacío: una acción sin cuerpo viaja como `{}`.
    body = (await req.text()) || '{}';
    headers['content-type'] = 'application/json';
  }
  const search = new URL(req.url).search;
  let res: Response;
  try {
    res = await fetch(`${apiBase()}/v1/personal/${path}${search}`, {
      method,
      headers,
      body,
      cache: 'no-store',
    });
  } catch {
    return NextResponse.json({ error: { code: 'upstream_unavailable' } }, { status: 502 });
  }
  const text = await res.text();
  const reply = new NextResponse(text || null, {
    status: res.status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
  return reply;
}

export async function GET(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  return handle(req, 'GET', (await ctx.params).path);
}

export async function POST(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  return handle(req, 'POST', (await ctx.params).path);
}
