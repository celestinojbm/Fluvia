import { NextResponse } from 'next/server';
import { apiBase, login } from '../../lib/api';

/**
 * Plano de sesión del dashboard (server-side). `POST` proxya el login a la API y,
 * si hay sesión, fija la cookie httpOnly `fluvia_session` (el token NUNCA llega
 * al JS del navegador). `DELETE` cierra sesión borrando la cookie.
 */

const COOKIE = 'fluvia_session';

export async function POST(req: Request) {
  const { email, password } = (await req.json().catch(() => ({}))) as {
    email?: string;
    password?: string;
  };
  if (typeof email !== 'string' || typeof password !== 'string') {
    return NextResponse.json({ ok: false, reason: 'bad_request' }, { status: 400 });
  }

  const result = await login({ apiBase: apiBase(), email, password });
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, reason: result.mfaRequired ? 'mfa' : 'invalid' },
      { status: 401 }
    );
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE, result.sessionToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 8,
  });
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 });
  return res;
}
