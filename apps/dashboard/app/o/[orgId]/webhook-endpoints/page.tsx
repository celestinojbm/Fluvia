import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  apiBase,
  canManageWebhooks,
  fetchOrganizations,
  fetchWebhookEndpoints,
} from '../../../lib/api';
import { WebhookEndpointsList } from '../../../lib/webhook-endpoints-view';
import { normalizeLocale } from '../../../messages';

export const dynamic = 'force-dynamic';

/**
 * Lista de webhook endpoints de la organización (F6.5B1). Gestión por sesión
 * (`webhooks:manage`); crear se ofrece solo a esos roles. El secreto jamás
 * llega en list/detail — solo una vez al crearlo (estado efímero del cliente).
 */
export default async function WebhookEndpointsPage({
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
  const [endpoints, orgs] = await Promise.all([
    fetchWebhookEndpoints({ apiBase: base, token, orgId }),
    fetchOrganizations({ apiBase: base, token }),
  ]);
  const role = orgs.find((o) => o.organization_id === orgId)?.role;
  return (
    <WebhookEndpointsList
      endpoints={endpoints}
      orgId={orgId}
      locale={normalizeLocale(lang)}
      signOutHref="/logout"
      canManage={canManageWebhooks(role)}
    />
  );
}
