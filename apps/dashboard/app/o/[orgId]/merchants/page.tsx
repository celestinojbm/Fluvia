import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { apiBase, fetchMerchants, filterMerchants } from '../../../lib/api';
import { MerchantsList } from '../../../lib/merchants-view';
import { normalizeLocale } from '../../../messages';

export const dynamic = 'force-dynamic';

/** «Buscar comercios» del panel admin (F4-04a): lista + filtro por `?q=`. */
export default async function MerchantsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ lang?: string; q?: string }>;
}) {
  const token = (await cookies()).get('fluvia_session')?.value;
  if (!token) redirect('/login');
  const { orgId } = await params;
  const { lang, q } = await searchParams;
  const merchants = await fetchMerchants({ apiBase: apiBase(), token, orgId });
  return (
    <MerchantsList
      merchants={filterMerchants(merchants, q)}
      hasAny={merchants.length > 0}
      orgId={orgId}
      query={q ?? ''}
      locale={normalizeLocale(lang)}
      signOutHref="/logout"
    />
  );
}
