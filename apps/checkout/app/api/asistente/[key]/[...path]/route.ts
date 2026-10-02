import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import {
  ALLOWED,
  API,
  cookieName,
  credentialHeaders,
  decodeCredential,
  rejectCrossSite,
} from '../../buyer-bff';

const PASS = ['content-type', 'x-fluvia-simulated', 'content-disposition'];
type Ctx = { params: Promise<{ key: string; path: string[] }> };

async function forward(req: Request, method: 'GET' | 'POST', ctx: Ctx) {
  if (method === 'POST') {
    const rejected = rejectCrossSite(req);
    if (rejected) return rejected;
  }
  const { key, path } = await ctx.params;
  const sub = path.join('/');
  const rule = ALLOWED.find((r) => r.re.test(sub));
  if (!/^[0-9a-f]{24}$/.test(key) || !rule || !rule.methods.includes(method)) {
    return NextResponse.json({ error: { code: 'not_found' } }, { status: 404 });
  }
  const cred = decodeCredential((await cookies()).get(cookieName(key))?.value);
  if (!cred) {
    return NextResponse.json({ error: { code: 'buyer_session_invalid' } }, { status: 401 });
  }
  const headers: Record<string, string> = credentialHeaders(cred);
  let body: BodyInit | undefined;
  if (method === 'POST') {
    if (sub === 'attachments') {
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
    res = await fetch(`${API}/v1/buyer/assistant/${sub}`, {
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
  for (const h of PASS) {
    const v = res.headers.get(h);
    if (v) out.set(h, v);
  }
  if (out.get('content-type')?.startsWith('text/event-stream')) out.set('x-accel-buffering', 'no');
  return new Response(res.body, { status: res.status, headers: out });
}

export const dynamic = 'force-dynamic';
export const GET = (req: Request, ctx: Ctx) => forward(req, 'GET', ctx);
export const POST = (req: Request, ctx: Ctx) => forward(req, 'POST', ctx);
