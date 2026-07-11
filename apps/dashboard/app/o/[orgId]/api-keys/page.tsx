import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { apiBase, fetchApiKeys } from '../../../lib/api';
import { ApiKeysList } from '../../../lib/api-keys-view';
import { normalizeLocale } from '../../../messages';

export const dynamic = 'force-dynamic';

/**
 * Lista de API keys de la organización — SOLO LECTURA por sesión (`keys:read`).
 * El API es la fuente de verdad del permiso: un rol sin `keys:read` recibe 404
 * (org invisible) o lista vacía. El secreto jamás llega aquí (F6.5B).
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
  const keys = await fetchApiKeys({ apiBase: apiBase(), token, orgId });
  return (
    <ApiKeysList
      keys={keys}
      orgId={orgId}
      locale={normalizeLocale(lang)}
      signOutHref="/logout"
    />
  );
}
