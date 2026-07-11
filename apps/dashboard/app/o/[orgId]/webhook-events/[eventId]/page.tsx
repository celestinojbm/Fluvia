import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import {
  apiBase,
  canResendRole,
  fetchOrganizations,
  fetchWebhookEvent,
} from '../../../../lib/api';
import { WebhookEventDetailView } from '../../../../lib/webhook-events-view';
import { normalizeLocale } from '../../../../messages';

export const dynamic = 'force-dynamic';

/** Detalle de un evento de webhook con payload e historial de intentos (F6.5B). */
export default async function WebhookEventDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; eventId: string }>;
  searchParams: Promise<{ lang?: string }>;
}) {
  const token = (await cookies()).get('fluvia_session')?.value;
  if (!token) redirect('/login');
  const { orgId, eventId } = await params;
  const { lang } = await searchParams;
  const base = apiBase();
  const [event, orgs] = await Promise.all([
    fetchWebhookEvent({ apiBase: base, token, orgId, eventId }),
    fetchOrganizations({ apiBase: base, token }),
  ]);
  if (!event) notFound();
  const role = orgs.find((o) => o.organization_id === orgId)?.role;
  return (
    <WebhookEventDetailView
      event={event}
      orgId={orgId}
      locale={normalizeLocale(lang)}
      signOutHref="/logout"
      canResend={canResendRole(role)}
    />
  );
}
