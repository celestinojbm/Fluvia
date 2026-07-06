import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { apiBase, fetchAuditEvents } from '../../../lib/api';
import { AuditEventsList } from '../../../lib/audit-events-view';
import { normalizeLocale } from '../../../messages';

export const dynamic = 'force-dynamic';

/** «Ver eventos» del panel admin (F4-04b): auditoría por sesión con cursor. */
export default async function EventsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ lang?: string; before?: string }>;
}) {
  const token = (await cookies()).get('fluvia_session')?.value;
  if (!token) redirect('/login');
  const { orgId } = await params;
  const { lang, before } = await searchParams;
  const { events, nextBefore } = await fetchAuditEvents({
    apiBase: apiBase(),
    token,
    orgId,
    before,
  });
  return (
    <AuditEventsList
      events={events}
      nextBefore={nextBefore}
      orgId={orgId}
      locale={normalizeLocale(lang)}
      signOutHref="/logout"
    />
  );
}
