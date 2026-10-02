import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { apiBase } from '../../../../../lib/api';
import { assertTrustedMutationRequest } from '../../../../../lib/csrf';

/**
 * BFF del local (restaurante), tipo de negocio y cobro presencial. Reenvía a
 * `/v1/organizations/:orgId/<ruta>` con la sesión del usuario (cookie
 * httpOnly → Bearer). Rutas ACOTADAS por lista blanca y método; mutaciones con
 * guard CSRF antes de leer cookie o cuerpo. El API decide permisos de
 * membresía y de local; aquí solo se transporta.
 *
 * `dining/stream` (SSE) se reenvía como flujo: el KDS recibe avisos en vivo y,
 * ante cualquiera o al reconectar, vuelve a pedir la instantánea.
 */
const U = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ROUTES: Array<{ method: 'GET' | 'POST' | 'PUT'; re: RegExp }> = [
  { method: 'GET', re: /^business-profile$/ },
  { method: 'PUT', re: /^business-profile$/ },
  { method: 'GET', re: /^collection-enablement$/ },
  {
    method: 'POST',
    re: /^collection-enablement\/requirements\/(identity|payout_account|terms|device)\/complete$/,
  },
  { method: 'POST', re: /^collection-enablement\/sandbox-decision$/ },
  { method: 'GET', re: /^venue$/ },
  { method: 'POST', re: /^venue\/(branches|areas|tables|stations|modifier-groups|staff)$/ },
  { method: 'POST', re: /^venue\/staff\/revoke$/ },
  { method: 'POST', re: new RegExp(`^venue/tables/${U}/rotate-qr$`) },
  { method: 'GET', re: /^venue\/staff$/ },
  { method: 'PUT', re: new RegExp(`^venue/products/${U}/(route|availability|info)$`) },
  { method: 'PUT', re: new RegExp(`^venue/products/${U}/modifier-groups/${U}$`) },
  { method: 'PUT', re: new RegExp(`^venue/modifier-options/${U}/availability$`) },
  { method: 'GET', re: new RegExp(`^venue/branches/${U}/menu$`) },
  { method: 'GET', re: /^dining\/orders$/ },
  { method: 'POST', re: /^dining\/orders$/ },
  { method: 'GET', re: new RegExp(`^dining/orders/${U}$`) },
  {
    method: 'POST',
    re: new RegExp(
      `^dining/orders/${U}/(lines|send|move|request-bill|decision|attention/clear|bill)$`
    ),
  },
  { method: 'GET', re: new RegExp(`^dining/orders/${U}/bill$`) },
  { method: 'POST', re: new RegExp(`^dining/orders/${U}/lines/${U}/void$`) },
  { method: 'GET', re: new RegExp(`^dining/bills/${U}$`) },
  { method: 'POST', re: new RegExp(`^dining/bills/${U}/allocations(/equal)?$`) },
  { method: 'POST', re: new RegExp(`^dining/bills/${U}/allocations/${U}/void$`) },
  { method: 'GET', re: /^dining\/(events|stream)$/ },
  { method: 'GET', re: /^kitchen\/(snapshot|history)$/ },
  { method: 'POST', re: new RegExp(`^kitchen/tickets/${U}/action$`) },
  { method: 'POST', re: /^in-person\/(devices|payments)$/ },
  { method: 'GET', re: /^in-person\/payments$/ },
  { method: 'GET', re: new RegExp(`^in-person/payments/${U}$`) },
  { method: 'POST', re: new RegExp(`^in-person/payments/${U}/(state|simulate)$`) },
  { method: 'GET', re: /^members$/ },
];

const QUERY_KEYS = new Set(['branch_id', 'scope', 'station', 'since']);

async function forward(
  req: Request,
  method: 'GET' | 'POST' | 'PUT',
  ctx: { params: Promise<{ orgId: string; path: string[] }> }
) {
  if (method !== 'GET') {
    const rejected = assertTrustedMutationRequest(req);
    if (rejected) return rejected;
  }
  const { orgId, path } = await ctx.params;
  const sub = path.join('/');
  if (
    !new RegExp(`^${U}$`).test(orgId) ||
    !ROUTES.some((r) => r.method === method && r.re.test(sub))
  ) {
    return NextResponse.json({ error: { code: 'not_found' } }, { status: 404 });
  }
  const token = (await cookies()).get('fluvia_session')?.value;
  if (!token) return NextResponse.json({ error: { code: 'invalid_session' } }, { status: 401 });
  // Solo parámetros de consulta conocidos (sin inyección de ruta ni de query).
  const inUrl = new URL(req.url);
  const q = new URLSearchParams();
  for (const [k, v] of inUrl.searchParams) {
    if (QUERY_KEYS.has(k) && /^[A-Za-z0-9_-]{1,64}$/.test(v)) q.set(k, v);
  }
  const qs = q.toString() ? `?${q.toString()}` : '';
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  let body: string | undefined;
  if (method !== 'GET') {
    body = (await req.text()) || '{}';
    headers['content-type'] = 'application/json';
  }
  const stream = sub === 'dining/stream';
  let res: Response;
  try {
    res = await fetch(`${apiBase()}/v1/organizations/${orgId}/${sub}${qs}`, {
      method,
      headers,
      body,
      cache: 'no-store',
      signal: stream ? req.signal : undefined,
    });
  } catch {
    return NextResponse.json({ error: { code: 'upstream_unavailable' } }, { status: 502 });
  }
  if (stream && res.ok && res.body) {
    return new Response(res.body, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        'x-accel-buffering': 'no',
      },
    });
  }
  return new NextResponse(await res.text(), {
    status: res.status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

type Ctx = { params: Promise<{ orgId: string; path: string[] }> };
export const dynamic = 'force-dynamic';
export const GET = (req: Request, ctx: Ctx) => forward(req, 'GET', ctx);
export const POST = (req: Request, ctx: Ctx) => forward(req, 'POST', ctx);
export const PUT = (req: Request, ctx: Ctx) => forward(req, 'PUT', ctx);
