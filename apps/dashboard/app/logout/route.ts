import { NextResponse } from 'next/server';

/** Cierra sesión: borra la cookie httpOnly y vuelve al login. */
export function GET(req: Request) {
  const res = NextResponse.redirect(new URL('/login', req.url));
  res.cookies.set('fluvia_session', '', { httpOnly: true, path: '/', maxAge: 0 });
  return res;
}
