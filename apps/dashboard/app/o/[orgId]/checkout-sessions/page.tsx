import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { apiBase, fetchCheckoutSessions } from '../../../lib/api';
import { CheckoutSessionsList } from '../../../lib/checkout-sessions-view';
import { normalizeLocale } from '../../../messages';

export const dynamic = 'force-dynamic';

/** Lista de sesiones de checkout de la organización — lectura por sesión. */
export default async function CheckoutSessionsPage({
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
  const sessions = await fetchCheckoutSessions({ apiBase: apiBase(), token, orgId });
  return (
    <CheckoutSessionsList
      sessions={sessions}
      orgId={orgId}
      locale={normalizeLocale(lang)}
      signOutHref="/logout"
    />
  );
}
