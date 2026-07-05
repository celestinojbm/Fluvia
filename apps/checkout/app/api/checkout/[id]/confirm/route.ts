import { NextResponse } from 'next/server';

/**
 * Proxy server-side a la API de Fluvia (F3-05c-iii `POST /confirm`). Reenvía el
 * `client_secret` y el método de pago; el navegador nunca toca la API directa.
 */

const API = process.env.FLUVIA_API_URL ?? 'http://127.0.0.1:3000';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const secret = req.headers.get('x-checkout-client-secret') ?? '';
  const body = await req.text();
  const res = await fetch(`${API}/v1/checkout_sessions/${encodeURIComponent(id)}/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-checkout-client-secret': secret },
    body,
    cache: 'no-store',
  });
  const out = await res.text();
  return new NextResponse(out, {
    status: res.status,
    headers: { 'content-type': 'application/json' },
  });
}
