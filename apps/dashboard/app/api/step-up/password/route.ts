import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { apiBase } from '../../../lib/api';

/**
 * Step-up por password (F6.5B2). Reenvía la cookie httpOnly como Bearer al
 * endpoint de auth EXISTENTE `POST /v1/auth/step-up/password` (NO se modifica el
 * mecanismo: solo se consume). El password llega en el cuerpo, se reenvía tal
 * cual UNA vez y NO se loguea ni se persiste. El servidor actualiza
 * `password_verified_at` en la fila de sesión; el navegador nunca sostiene un
 * "token de step-up". Un usuario con MFA recibe 403 (StepUpRequiredError): el
 * password NO sustituye al factor fuerte. `cache: 'no-store'`.
 */
export async function POST(req: Request) {
  const token = (await cookies()).get('fluvia_session')?.value;
  if (!token) return NextResponse.json({ ok: false }, { status: 401 });

  const res = await fetch(`${apiBase()}/v1/auth/step-up/password`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: await req.text(),
    cache: 'no-store',
  });
  const body = await res.text();
  return new NextResponse(body, {
    status: res.status,
    headers: { 'content-type': 'application/json' },
  });
}
