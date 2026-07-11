import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { apiBase, canResendRole, fetchOrganizations, fetchWebhookEvents } from '../../../lib/api';
import { WebhookEventsList } from '../../../lib/webhook-events-view';
import { normalizeLocale } from '../../../messages';

export const dynamic = 'force-dynamic';

/** Lista de eventos de webhook de la organización — lectura por sesión (F6.5B). */
export default async function WebhookEventsPage({
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
  const [events, orgs] = await Promise.all([
    fetchWebhookEvents({ apiBase: base, token, orgId }),
    fetchOrganizations({ apiBase: base, token }),
  ]);
  const role = orgs.find((o) => o.organization_id === orgId)?.role;
  return (
    <WebhookEventsList
      events={events}
      orgId={orgId}
      locale={normalizeLocale(lang)}
      signOutHref="/logout"
      canResend={canResendRole(role)}
    />
  );
}
