import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import {
  apiBase,
  canManageWebhooks,
  fetchOrganizations,
  fetchWebhookEndpoint,
} from '../../../../lib/api';
import { WebhookEndpointDetailView } from '../../../../lib/webhook-endpoints-view';
import { normalizeLocale } from '../../../../messages';

export const dynamic = 'force-dynamic';

/** Detalle de un webhook endpoint con acciones rotar/desactivar (F6.5B1). */
export default async function WebhookEndpointDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; endpointId: string }>;
  searchParams: Promise<{ lang?: string }>;
}) {
  const token = (await cookies()).get('fluvia_session')?.value;
  if (!token) redirect('/login');
  const { orgId, endpointId } = await params;
  const { lang } = await searchParams;
  const base = apiBase();
  const [endpoint, orgs] = await Promise.all([
    fetchWebhookEndpoint({ apiBase: base, token, orgId, endpointId }),
    fetchOrganizations({ apiBase: base, token }),
  ]);
  if (!endpoint) notFound();
  const role = orgs.find((o) => o.organization_id === orgId)?.role;
  return (
    <WebhookEndpointDetailView
      endpoint={endpoint}
      orgId={orgId}
      locale={normalizeLocale(lang)}
      signOutHref="/logout"
      canManage={canManageWebhooks(role)}
    />
  );
}
