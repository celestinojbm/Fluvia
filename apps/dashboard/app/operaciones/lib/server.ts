import { cookies } from 'next/headers';
import { readApi, type Read } from '../../lib/commerce-api';

/** Lectura server-side del plano de operación del programa (sesión del operador). */
export async function readOps<T>(orgId: string, path: string): Promise<Read<T>> {
  const token = (await cookies()).get('fluvia_session')?.value;
  if (!token) return { kind: 'unauthorized' };
  return readApi<T>(token, `/v1/programs/${orgId}${path}`);
}
