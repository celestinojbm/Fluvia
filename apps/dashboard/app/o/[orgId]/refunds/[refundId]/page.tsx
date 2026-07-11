import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { apiBase, fetchRefund } from '../../../../lib/api';
import { RefundDetail } from '../../../../lib/refunds-view';
import { normalizeLocale } from '../../../../messages';

export const dynamic = 'force-dynamic';

/** Detalle de un reembolso — lectura por sesión. */
export default async function RefundDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; refundId: string }>;
  searchParams: Promise<{ lang?: string }>;
}) {
  const token = (await cookies()).get('fluvia_session')?.value;
  if (!token) redirect('/login');
  const { orgId, refundId } = await params;
  const { lang } = await searchParams;
  const refund = await fetchRefund({ apiBase: apiBase(), token, orgId, refundId });
  if (!refund) notFound();
  return (
    <RefundDetail
      refund={refund}
      orgId={orgId}
      locale={normalizeLocale(lang)}
      signOutHref="/logout"
    />
  );
}
