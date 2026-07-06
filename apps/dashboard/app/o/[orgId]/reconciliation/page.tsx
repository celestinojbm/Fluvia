import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { apiBase, fetchSettlementReports } from '../../../lib/api';
import { ReconciliationList } from '../../../lib/reconciliation-view';
import { normalizeLocale } from '../../../messages';

export const dynamic = 'force-dynamic';

/** Lista de reportes de liquidación de la organización (lectura por sesión). */
export default async function ReconciliationPage({
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
  const reports = await fetchSettlementReports({ apiBase: apiBase(), token, orgId });
  return (
    <ReconciliationList
      reports={reports}
      orgId={orgId}
      locale={normalizeLocale(lang)}
      signOutHref="/logout"
    />
  );
}
