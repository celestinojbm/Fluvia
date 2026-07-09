import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import {
  apiBase,
  canManageReconciliation,
  fetchDispute,
  fetchOrganizations,
} from '../../../../lib/api';
import { DisputesDetail } from '../../../../lib/disputes-view';
import { normalizeLocale } from '../../../../messages';

export const dynamic = 'force-dynamic';

/**
 * Detalle de una disputa (lectura por sesión) + la ÚNICA acción de operación:
 * RESPONDER con evidencia (F4-08e). Trae la membresía para saber el rol del
 * operador y mostrar (o no) la acción — hint de UX; la API es la fuente de verdad
 * (`reconciliation:manage`).
 */
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
  const base = apiBase();
  const [orgs, dispute] = await Promise.all([
    fetchOrganizations({ apiBase: base, token }),
    fetchDispute({ apiBase: base, token, orgId, disputeId }),
  ]);
  if (!dispute) notFound();
  const role = orgs.find((o) => o.organization_id === orgId)?.role;
  return (
    <DisputesDetail
      dispute={dispute}
      orgId={orgId}
      locale={normalizeLocale(lang)}
      canManage={canManageReconciliation(role)}
      signOutHref="/logout"
    />
  );
}
