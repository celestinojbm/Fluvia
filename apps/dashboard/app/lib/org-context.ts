import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { apiBase, fetchOrganizations } from './api';

/**
 * Contexto server-side de una página de organización: token de sesión (sin
 * cookie ⇒ /login) y rol de la membresía (PISTA de UX; el API autoriza).
 */
export async function orgContext(
  orgId: string
): Promise<{ token: string; role: string | undefined }> {
  const token = (await cookies()).get('fluvia_session')?.value;
  if (!token) redirect('/login');
  const orgs = await fetchOrganizations({ apiBase: apiBase(), token });
  return { token, role: orgs.find((o) => o.organization_id === orgId)?.role };
}
