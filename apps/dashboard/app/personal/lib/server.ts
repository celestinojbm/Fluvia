import { cookies } from 'next/headers';
import { apiBase } from '../../lib/api';

/**
 * Fluvia Personal — acceso server-side a la API con la sesión del CLIENTE.
 * La sesión vive en la cookie httpOnly `fluvia_personal` (distinta de la de
 * comercio/operación); el navegador jamás conoce el token ni la URL de la API.
 */
export const PERSONAL_COOKIE = 'fluvia_personal';

export type Read<T> =
  { kind: 'ok'; data: T } | { kind: 'unauthorized' } | { kind: 'not_found' } | { kind: 'error' };

export function programId(): string | null {
  const v = process.env.FLUVIA_PROGRAM_TENANT_ID ?? '';
  return /^[0-9a-f-]{36}$/i.test(v) ? v : null;
}

export async function personalToken(): Promise<string | null> {
  return (await cookies()).get(PERSONAL_COOKIE)?.value ?? null;
}

export async function readPersonal<T>(path: string): Promise<Read<T>> {
  const token = await personalToken();
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await fetch(`${apiBase()}/v1/personal${path}`, {
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (res.status === 401) return { kind: 'unauthorized' };
    if (res.status === 404) return { kind: 'not_found' };
    if (!res.ok) return { kind: 'error' };
    return { kind: 'ok', data: (await res.json()) as T };
  } catch {
    return { kind: 'error' };
  }
}
