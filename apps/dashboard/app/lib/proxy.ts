import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { apiBase } from './api';

/**
 * Reenvía un POST a una ruta de OPERACIÓN por sesión de la API, adjuntando la
 * cookie httpOnly `fluvia_session` como `Authorization: Bearer`. El navegador
 * nunca sostiene el token ni conoce la URL de la API. Sin sesión → 401. El
 * status y el cuerpo (el sobre de error estable del catálogo, con su `code`) se
 * transmiten TAL CUAL para que la UI pueda distinguir p. ej. `four_eyes_required`
 * (409) de un `insufficient_permissions` (403).
 */
export async function proxySessionPost(apiPath: string, body?: string): Promise<NextResponse> {
  const token = (await cookies()).get('fluvia_session')?.value;
  if (!token) return NextResponse.json({ ok: false }, { status: 401 });

  const res = await fetch(`${apiBase()}${apiPath}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body,
    cache: 'no-store',
  });
  const text = await res.text();
  return new NextResponse(text, {
    status: res.status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Ruta de un caso operativo por sesión. */
export function casePath(orgId: string, id: string, action: string): string {
  return `/v1/organizations/${encodeURIComponent(orgId)}/operational_cases/${encodeURIComponent(id)}/${action}`;
}

/** Ruta de un ajuste de caso por sesión. */
export function adjustmentPath(orgId: string, id: string, action: string): string {
  return `/v1/organizations/${encodeURIComponent(orgId)}/case_adjustments/${encodeURIComponent(id)}/${action}`;
}

/** Ruta de una disputa por sesión (F4-08e). */
export function disputePath(orgId: string, id: string, action: string): string {
  return `/v1/organizations/${encodeURIComponent(orgId)}/disputes/${encodeURIComponent(id)}/${action}`;
}
