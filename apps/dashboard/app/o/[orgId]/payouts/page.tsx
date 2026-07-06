import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { apiBase, fetchPayouts } from '../../../lib/api';
import { PayoutsList } from '../../../lib/payouts-view';
import { normalizeLocale } from '../../../messages';

export const dynamic = 'force-dynamic';

/** Lista de payouts de la organización (money out, lectura por sesión). */
export default async function PayoutsPage({
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
  const payouts = await fetchPayouts({ apiBase: apiBase(), token, orgId });
  return (
    <PayoutsList
      payouts={payouts}
      orgId={orgId}
      locale={normalizeLocale(lang)}
      signOutHref="/logout"
    />
  );
}
