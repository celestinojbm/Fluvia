import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { apiBase, fetchPayout } from '../../../../lib/api';
import { PayoutsDetail } from '../../../../lib/payouts-view';
import { normalizeLocale } from '../../../../messages';

export const dynamic = 'force-dynamic';

/** Detalle de un payout (lectura por sesión). */
export default async function PayoutDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; payoutId: string }>;
  searchParams: Promise<{ lang?: string }>;
}) {
  const token = (await cookies()).get('fluvia_session')?.value;
  if (!token) redirect('/login');
  const { orgId, payoutId } = await params;
  const { lang } = await searchParams;
  const payout = await fetchPayout({ apiBase: apiBase(), token, orgId, payoutId });
  if (!payout) notFound();
  return (
    <PayoutsDetail
      payout={payout}
      orgId={orgId}
      locale={normalizeLocale(lang)}
      signOutHref="/logout"
    />
  );
}
