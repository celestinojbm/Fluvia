import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  apiBase,
  canManageReconciliation,
  fetchMerchants,
  fetchOrganizations,
  fetchPaymentLinks,
} from '../../../lib/api';
import { PaymentLinksList } from '../../../lib/payment-links-view';
import { normalizeLocale } from '../../../messages';

export const dynamic = 'force-dynamic';

/**
 * Lista de payment links de la organización — lectura por sesión. Crear un
 * link (F6.5A-bis) solo se ofrece a roles con reconciliation:manage.
 */
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
  const base = apiBase();
  const [links, orgs, merchants] = await Promise.all([
    fetchPaymentLinks({ apiBase: base, token, orgId }),
    fetchOrganizations({ apiBase: base, token }),
    fetchMerchants({ apiBase: base, token, orgId }),
  ]);
  const role = orgs.find((o) => o.organization_id === orgId)?.role;
  return (
    <PaymentLinksList
      links={links}
      orgId={orgId}
      locale={normalizeLocale(lang)}
      signOutHref="/logout"
      canManage={canManageReconciliation(role)}
      merchants={merchants}
    />
  );
}
