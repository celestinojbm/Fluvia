import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  apiBase,
  canManageReconciliation,
  fetchMerchants,
  fetchOrganizations,
} from '../../../lib/api';
import { UUID_RE } from '../../../lib/pos-contract';
import { POS_MESSAGES } from '../../../lib/pos-messages';
import { FlowNav } from '../../../lib/flow-nav';
import { fetchRecentCharges } from '../../../lib/pos-reads';
import { PosWorkspace } from '../../../lib/pos-workspace';
import { normalizeLocale } from '../../../messages';

export const dynamic = 'force-dynamic';

/**
 * POS web sandbox de una organización. Server-side: sesión obligatoria, rol y
 * comercios activos por el plano de sesión; el terminal (cliente) crea la venta
 * y sigue su estado por los BFF. `?session=&link=` reanuda el seguimiento tras
 * recargar (solo ids validados; el `client_secret` nunca viaja en la URL).
 */
export default async function PosPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ lang?: string; session?: string; link?: string }>;
}) {
  const token = (await cookies()).get('fluvia_session')?.value;
  if (!token) redirect('/login');
  const { orgId } = await params;
  const { lang, session, link } = await searchParams;
  const locale = normalizeLocale(lang);
  const t = POS_MESSAGES[locale];

  const base = apiBase();
  const [orgs, merchants, recent] = await Promise.all([
    fetchOrganizations({ apiBase: base, token }),
    fetchMerchants({ apiBase: base, token, orgId }),
    fetchRecentCharges({ apiBase: base, token, orgId }),
  ]);
  const org = orgs.find((o) => o.organization_id === orgId);
  const active = merchants.filter((m) => m.status === 'active');
  const resume =
    typeof session === 'string' && UUID_RE.test(session)
      ? {
          sessionId: session,
          linkId: typeof link === 'string' && UUID_RE.test(link) ? link : null,
        }
      : undefined;

  return (
    <main className="dash pos" aria-labelledby="pos-title">
      <FlowNav orgId={orgId} locale={locale} current="pos" />
      <header className="dash-head">
        <div>
          <h1 id="pos-title">{t.title}</h1>
          <p className="org">
            {org?.name ?? orgId} · {t.subtitle}
          </p>
        </div>
      </header>
      <PosWorkspace
        orgId={orgId}
        locale={locale}
        merchants={active}
        allMerchants={merchants.map((m) => ({ id: m.id, name: m.name }))}
        canCharge={canManageReconciliation(org?.role)}
        resume={resume}
        recent={recent}
      />
      <p className="notice">{t.sandboxNotice}</p>
    </main>
  );
}
