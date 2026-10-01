import { NextResponse } from 'next/server';
import { apiBase } from '../../lib/api';
import { assertTrustedMutationRequest } from '../../lib/csrf';
import { PERSONAL_COOKIE, personalToken, programId } from '../../personal/lib/server';

/**
 * Sesión de Fluvia Personal (server-side). POST `{mode:'login'|'register', …}`
 * proxya a la API del programa configurado y fija la cookie httpOnly
 * `fluvia_personal`; DELETE cierra la sesión en la API y borra la cookie.
 * Guard CSRF same-origin en ambas mutaciones.
 */
export async function POST(req: Request) {
  const rejected = assertTrustedMutationRequest(req);
  if (rejected) return rejected;
  const program = programId();
  if (!program) {
    return NextResponse.json({ error: { code: 'program_not_configured' } }, { status: 503 });
  }
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const mode = body.mode === 'register' ? 'register' : 'login';
  const payload =
    mode === 'register'
      ? {
          email: body.email,
          password: body.password,
          display_name: body.display_name,
          synthetic_risk_profile: body.synthetic_risk_profile,
        }
      : { email: body.email, password: body.password };
  let res: Response;
  try {
    res = await fetch(`${apiBase()}/v1/personal/programs/${program}/${mode}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      cache: 'no-store',
    });
  } catch {
    return NextResponse.json({ error: { code: 'upstream_unavailable' } }, { status: 502 });
  }
  const out = (await res.json().catch(() => ({}))) as { session?: string; error?: unknown };
  if (!res.ok || typeof out.session !== 'string') {
    return NextResponse.json(
      { error: out.error ?? { code: 'invalid' } },
      { status: res.status || 400 }
    );
  }
  const reply = NextResponse.json({ ok: true });
  reply.cookies.set(PERSONAL_COOKIE, out.session, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 12,
  });
  return reply;
}

export async function DELETE(req: Request) {
  const rejected = assertTrustedMutationRequest(req);
  if (rejected) return rejected;
  const token = await personalToken();
  if (token) {
    await fetch(`${apiBase()}/v1/personal/logout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store',
    }).catch(() => undefined);
  }
  const reply = NextResponse.json({ ok: true });
  reply.cookies.set(PERSONAL_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 });
  return reply;
}
