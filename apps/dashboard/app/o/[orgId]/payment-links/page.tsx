import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { apiBase, fetchPaymentLinks } from '../../../lib/api';
import { PaymentLinksList } from '../../../lib/payment-links-view';
import { normalizeLocale } from '../../../messages';

export const dynamic = 'force-dynamic';

/** Lista de payment links de la organización — lectura por sesión. */
export default async function PaymentLinksPage({
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
  const links = await fetchPaymentLinks({ apiBase: apiBase(), token, orgId });
  return (
    <PaymentLinksList
      links={links}
      orgId={orgId}
      locale={normalizeLocale(lang)}
      signOutHref="/logout"
    />
  );
}
