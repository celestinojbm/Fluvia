import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { apiBase, fetchRefunds } from '../../../lib/api';
import { RefundsList } from '../../../lib/refunds-view';
import { normalizeLocale } from '../../../messages';

export const dynamic = 'force-dynamic';

/** Lista de reembolsos de la organización — lectura por sesión. */
export default async function RefundsPage({
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
  const refunds = await fetchRefunds({ apiBase: apiBase(), token, orgId });
  return (
    <RefundsList
      refunds={refunds}
      orgId={orgId}
      locale={normalizeLocale(lang)}
      signOutHref="/logout"
    />
  );
}
