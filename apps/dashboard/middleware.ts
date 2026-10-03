import { NextResponse, type NextRequest } from 'next/server';

/**
 * Solo Fluvia Personal: pasa la ruta pedida (con su query) al layout en una
 * cabecera interna para que, sin sesión, «Entrar» devuelva a la persona al
 * mismo sitio (enlace profundo). La cabecera entrante se sobrescribe siempre:
 * el cliente no puede inyectarla.
 */
export function middleware(req: NextRequest) {
  const headers = new Headers(req.headers);
  headers.set('x-fluvia-personal-path', `${req.nextUrl.pathname}${req.nextUrl.search}`);
  return NextResponse.next({ request: { headers } });
}

export const config = { matcher: ['/personal/:path*'] };
