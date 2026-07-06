import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { apiBase, fetchDisputes } from '../../../lib/api';
import { DisputesList } from '../../../lib/disputes-view';
import { normalizeLocale } from '../../../messages';

export const dynamic = 'force-dynamic';

/** Lista de disputas de la organización (money clawed back, lectura por sesión). */
export default async function DisputesPage({
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
  const disputes = await fetchDisputes({ apiBase: apiBase(), token, orgId });
  return (
    <DisputesList
      disputes={disputes}
      orgId={orgId}
      locale={normalizeLocale(lang)}
      signOutHref="/logout"
    />
  );
}
