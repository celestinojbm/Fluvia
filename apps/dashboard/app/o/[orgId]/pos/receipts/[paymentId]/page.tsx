import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { apiBase, fetchOrganizations } from '../../../../../lib/api';
import { FlowNav } from '../../../../../lib/flow-nav';
import { UUID_RE } from '../../../../../lib/pos-contract';
import { PosReceiptView } from '../../../../../lib/pos-receipt';
import { POS_RECEIPT_MESSAGES } from '../../../../../lib/pos-receipt-messages';
import { normalizeLocale } from '../../../../../messages';

export const dynamic = 'force-dynamic';

/**
 * Justificante de un cobro del POS. Server-side: sesión obligatoria e id
 * validado; el nombre de la organización sale de `GET /v1/organizations`. El
 * contenido del justificante lo lee el cliente por el BFF (se puede releer sin
 * recargar). Justificante operativo: NO es una factura.
 */
export default async function PosReceiptPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; paymentId: string }>;
  searchParams: Promise<{ lang?: string }>;
}) {
  const token = (await cookies()).get('fluvia_session')?.value;
  if (!token) redirect('/login');
  const { orgId, paymentId } = await params;
  if (!UUID_RE.test(orgId) || !UUID_RE.test(paymentId)) notFound();
  const { lang } = await searchParams;
  const locale = normalizeLocale(lang);
  const t = POS_RECEIPT_MESSAGES[locale];

  const orgs = await fetchOrganizations({ apiBase: apiBase(), token });
  const org = orgs.find((o) => o.organization_id === orgId);

  return (
    <main className="dash pos pos-receipt-page" aria-label={t.docTitle}>
      <FlowNav orgId={orgId} locale={locale} current={null} />
      <header className="dash-head no-print">
        <div>
          <h1>{t.pageTitle}</h1>
          {org && <p className="org">{org.name}</p>}
        </div>
      </header>
      <PosReceiptView
        orgId={orgId}
        orgName={org?.name ?? null}
        paymentId={paymentId}
        locale={locale}
      />
    </main>
  );
}
