import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { apiBase, fetchPaymentLink } from '../../../../lib/api';
import { PaymentLinkDetail } from '../../../../lib/payment-links-view';
import { normalizeLocale } from '../../../../messages';

export const dynamic = 'force-dynamic';

/** Detalle de un payment link (con copia de la URL sandbox). */
export default async function PaymentLinkDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; linkId: string }>;
  searchParams: Promise<{ lang?: string }>;
}) {
  const token = (await cookies()).get('fluvia_session')?.value;
  if (!token) redirect('/login');
  const { orgId, linkId } = await params;
  const { lang } = await searchParams;
  const link = await fetchPaymentLink({ apiBase: apiBase(), token, orgId, linkId });
  if (!link) notFound();
  return (
    <PaymentLinkDetail
      link={link}
      orgId={orgId}
      locale={normalizeLocale(lang)}
      signOutHref="/logout"
    />
  );
}
