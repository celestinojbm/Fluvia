import { NextResponse } from 'next/server';

/**
 * Proxy server-side a la API de Fluvia (F3-05c-i `GET /status`). El navegador
 * llama a este handler del MISMO origen; la URL de la API (FLUVIA_API_URL) y el
 * reenvío del `client_secret` quedan del lado del servidor. Sin cache: refleja
 * el estado vivo de la sesión.
 */

const API = process.env.FLUVIA_API_URL ?? 'http://127.0.0.1:3000';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const secret = req.headers.get('x-checkout-client-secret') ?? '';
  const res = await fetch(`${API}/v1/checkout_sessions/${encodeURIComponent(id)}/status`, {
    headers: { 'x-checkout-client-secret': secret },
    cache: 'no-store',
  });
  const body = await res.text();
  return new NextResponse(body, {
    status: res.status,
    headers: { 'content-type': 'application/json' },
  });
}
