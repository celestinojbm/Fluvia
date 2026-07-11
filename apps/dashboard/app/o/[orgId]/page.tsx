import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  apiBase,
  canManageWebhooks,
  canReadAudit,
  canReadKeys,
  canResendRole,
  fetchDashboardData,
  fetchOrganizations,
} from '../../lib/api';
import { DashboardView } from '../../lib/dashboard-view';
import { normalizeLocale } from '../../messages';

export const dynamic = 'force-dynamic';

/**
 * Panel de una organización. Lee la cookie server-side (sin sesión → `/login`),
 * trae las 5 vistas del plano de lectura (`/v1/organizations/:orgId/*`) con el
 * token, y renderiza `DashboardView`. Todo server-side; el token no llega al
 * navegador. Una org ajena (sin membresía) devuelve listas vacías (404 del API).
 */
export default async function OrgDashboardPage({
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
  const locale = normalizeLocale(lang);

  const base = apiBase();
  const [orgs, data] = await Promise.all([
    fetchOrganizations({ apiBase: base, token }),
    fetchDashboardData({ apiBase: base, token, orgId }),
  ]);
  const org = orgs.find((o) => o.organization_id === orgId);
  const orgName = org?.name ?? orgId;

  return (
    <DashboardView
      data={data}
      locale={locale}
      orgId={orgId}
      orgName={orgName}
      signOutHref="/logout"
      canResend={canResendRole(org?.role)}
      canReadAudit={canReadAudit(org?.role)}
      canReadKeys={canReadKeys(org?.role)}
      canManageWebhooks={canManageWebhooks(org?.role)}
    />
  );
}
