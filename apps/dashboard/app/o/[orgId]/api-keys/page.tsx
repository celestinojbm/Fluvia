import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { apiBase, canManageKeys, fetchApiKeys, fetchOrganizations } from '../../../lib/api';
import { ApiKeysList } from '../../../lib/api-keys-view';
import { normalizeLocale } from '../../../messages';

export const dynamic = 'force-dynamic';

/**
 * Lista de API keys de la organización — lectura por sesión (`keys:read`). El
 * API es la fuente de verdad del permiso: un rol sin `keys:read` recibe 404
 * (org invisible) o lista vacía. El secreto jamás llega aquí. Crear/revocar
 * (F6.5B2) se ofrece solo a roles con `keys:manage` (owner/admin/developer);
 * el API además exige step-up MFA.
 */
export default async function ApiKeysPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ lang?: string }>;
}) {
  const token = (await cookies()).get('fluvia_session')?.value;
  if (!token) redirect('/login');
  const { orgId } = await params;
  const { lang } = await searchParams;
  const base = apiBase();
  const [keys, orgs] = await Promise.all([
    fetchApiKeys({ apiBase: base, token, orgId }),
    fetchOrganizations({ apiBase: base, token }),
  ]);
  const role = orgs.find((o) => o.organization_id === orgId)?.role;
  return (
    <ApiKeysList
      keys={keys}
      orgId={orgId}
      locale={normalizeLocale(lang)}
      signOutHref="/logout"
      canManage={canManageKeys(role)}
    />
  );
}
