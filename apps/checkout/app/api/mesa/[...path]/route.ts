import { NextResponse } from 'next/server';

/**
 * Proxy PÚBLICO del comensal: menú de la mesa (token del QR), su pedido y su
 * seguimiento (token privado). Rutas acotadas; el navegador nunca conoce la
 * URL de la API. Sin respuesta de la API ⇒ 502 (la UI lo trata como incierto:
 * reintenta con la MISMA Idempotency-Key, sin duplicar el pedido).
 */
const API = process.env.FLUVIA_API_URL ?? 'http://127.0.0.1:3000';
const TOKEN = '[A-Za-z0-9_-]{20,64}';
const ROUTES: Array<{ method: 'GET' | 'POST'; re: RegExp; api: (m: RegExpMatchArray) => string }> =
  [
    { method: 'GET', re: new RegExp(`^t/(${TOKEN})$`), api: (m) => `/v1/public/tables/${m[1]}` },
    {
      method: 'POST',
      re: new RegExp(`^t/(${TOKEN})/orders$`),
      api: (m) => `/v1/public/tables/${m[1]}/orders`,
    },
    {
      method: 'GET',
      re: new RegExp(`^o/(${TOKEN})$`),
      api: (m) => `/v1/public/dining/orders/${m[1]}`,
    },
    {
      method: 'GET',
      re: new RegExp(`^o/(${TOKEN})/bill$`),
      api: (m) => `/v1/public/dining/orders/${m[1]}/bill`,
    },
    {
      method: 'POST',
      re: new RegExp(`^o/(${TOKEN})/attention$`),
      api: (m) => `/v1/public/dining/orders/${m[1]}/attention`,
    },
  ];

async function forward(
  req: Request,
  method: 'GET' | 'POST',
  ctx: { params: Promise<{ path: string[] }> }
) {
  const sub = (await ctx.params).path.join('/');
  let target: string | null = null;
  for (const r of ROUTES) {
    const m = r.method === method ? sub.match(r.re) : null;
    if (m) target = r.api(m);
  }
  if (!target) return NextResponse.json({ error: { code: 'not_found' } }, { status: 404 });
  const headers: Record<string, string> = {};
  let body: string | undefined;
  if (method === 'POST') {
    body = (await req.text()) || '{}';
    headers['content-type'] = 'application/json';
    const key = req.headers.get('idempotency-key');
    if (key) headers['idempotency-key'] = key;
  }
  let res: Response;
  try {
    res = await fetch(`${API}${target}`, { method, headers, body, cache: 'no-store' });
  } catch {
    return NextResponse.json({ error: { code: 'upstream_unavailable' } }, { status: 502 });
  }
  return new NextResponse(await res.text(), {
    status: res.status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

type Ctx = { params: Promise<{ path: string[] }> };
export const dynamic = 'force-dynamic';
export const GET = (req: Request, ctx: Ctx) => forward(req, 'GET', ctx);
export const POST = (req: Request, ctx: Ctx) => forward(req, 'POST', ctx);
