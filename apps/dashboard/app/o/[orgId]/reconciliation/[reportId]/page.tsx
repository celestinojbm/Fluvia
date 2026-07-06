import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { apiBase, fetchReconciliationEntries, fetchSettlementReport } from '../../../../lib/api';
import { ReconciliationDetail } from '../../../../lib/reconciliation-view';
import { normalizeLocale } from '../../../../messages';

export const dynamic = 'force-dynamic';

/** Detalle de un reporte: resumen + discrepancias (lectura por sesión). */
export default async function ReconciliationDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; reportId: string }>;
  searchParams: Promise<{ lang?: string }>;
}) {
  const token = (await cookies()).get('fluvia_session')?.value;
  if (!token) redirect('/login');
  const { orgId, reportId } = await params;
  const { lang } = await searchParams;
  const base = apiBase();
  const [report, entries] = await Promise.all([
    fetchSettlementReport({ apiBase: base, token, orgId, reportId }),
    fetchReconciliationEntries({ apiBase: base, token, orgId, reportId }),
  ]);
  if (!report) notFound();
  return (
    <ReconciliationDetail
      report={report}
      entries={entries}
      orgId={orgId}
      locale={normalizeLocale(lang)}
      signOutHref="/logout"
    />
  );
}
