import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { apiBase, fetchDispute } from '../../../../lib/api';
import { DisputesDetail } from '../../../../lib/disputes-view';
import { normalizeLocale } from '../../../../messages';

export const dynamic = 'force-dynamic';

/** Detalle de una disputa (lectura por sesión). */
export default async function DisputeDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; disputeId: string }>;
  searchParams: Promise<{ lang?: string }>;
}) {
  const token = (await cookies()).get('fluvia_session')?.value;
  if (!token) redirect('/login');
  const { orgId, disputeId } = await params;
  const { lang } = await searchParams;
  const dispute = await fetchDispute({ apiBase: apiBase(), token, orgId, disputeId });
  if (!dispute) notFound();
  return (
    <DisputesDetail
      dispute={dispute}
      orgId={orgId}
      locale={normalizeLocale(lang)}
      signOutHref="/logout"
    />
  );
}
