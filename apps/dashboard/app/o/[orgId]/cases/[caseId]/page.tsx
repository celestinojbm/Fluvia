import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import {
  apiBase,
  canManageReconciliation,
  fetchOperationalCase,
  fetchOrganizations,
} from '../../../../lib/api';
import { CaseDetail } from '../../../../lib/cases-view';
import { normalizeLocale } from '../../../../messages';

export const dynamic = 'force-dynamic';

/**
 * Detalle de un caso: discrepancia + ajustes + acciones (acknowledge/resolve/
 * proponer/aprobar/rechazar). Trae la membresía para saber el rol del operador y
 * mostrar (o no) las acciones — hint de UX; la API es la fuente de verdad.
 */
export default async function CaseDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; caseId: string }>;
  searchParams: Promise<{ lang?: string }>;
}) {
  const token = (await cookies()).get('fluvia_session')?.value;
  if (!token) redirect('/login');
  const { orgId, caseId } = await params;
  const { lang } = await searchParams;
  const base = apiBase();
  const [orgs, kase] = await Promise.all([
    fetchOrganizations({ apiBase: base, token }),
    fetchOperationalCase({ apiBase: base, token, orgId, caseId }),
  ]);
  if (!kase) notFound();
  const role = orgs.find((o) => o.organization_id === orgId)?.role;
  return (
    <CaseDetail
      kase={kase}
      orgId={orgId}
      locale={normalizeLocale(lang)}
      canManage={canManageReconciliation(role)}
      signOutHref="/logout"
    />
  );
}
