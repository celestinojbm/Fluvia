import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { apiBase, fetchOperationalCases, type CaseStatus } from '../../../lib/api';
import { CasesList } from '../../../lib/cases-view';
import { normalizeLocale } from '../../../messages';

export const dynamic = 'force-dynamic';

const CASE_STATUSES: CaseStatus[] = ['open', 'acknowledged', 'resolved'];
function asStatus(raw: string | undefined): CaseStatus | undefined {
  return raw && (CASE_STATUSES as string[]).includes(raw) ? (raw as CaseStatus) : undefined;
}

/** Lista de casos operativos de la organización (lectura por sesión). */
export default async function CasesPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ lang?: string; status?: string }>;
}) {
  const token = (await cookies()).get('fluvia_session')?.value;
  if (!token) redirect('/login');
  const { orgId } = await params;
  const { lang, status } = await searchParams;
  const activeStatus = asStatus(status);
  const cases = await fetchOperationalCases({
    apiBase: apiBase(),
    token,
    orgId,
    status: activeStatus,
  });
  return (
    <CasesList
      cases={cases}
      orgId={orgId}
      locale={normalizeLocale(lang)}
      activeStatus={activeStatus}
      signOutHref="/logout"
    />
  );
}
