import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { apiBase, fetchCheckoutSession } from '../../../../lib/api';
import { CheckoutSessionDetail } from '../../../../lib/checkout-sessions-view';
import { normalizeLocale } from '../../../../messages';

export const dynamic = 'force-dynamic';

/** Detalle de una sesión de checkout (con copia de la URL sandbox). */
export default async function CheckoutSessionDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; sessionId: string }>;
  searchParams: Promise<{ lang?: string }>;
}) {
  const token = (await cookies()).get('fluvia_session')?.value;
  if (!token) redirect('/login');
  const { orgId, sessionId } = await params;
  const { lang } = await searchParams;
  const session = await fetchCheckoutSession({ apiBase: apiBase(), token, orgId, sessionId });
  if (!session) notFound();
  return (
    <CheckoutSessionDetail
      session={session}
      orgId={orgId}
      locale={normalizeLocale(lang)}
      signOutHref="/logout"
    />
  );
}
