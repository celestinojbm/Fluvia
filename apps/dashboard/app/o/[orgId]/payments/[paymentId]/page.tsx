import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import {
  apiBase,
  canManageReconciliation,
  fetchCheckoutSessions,
  fetchOrganizations,
  fetchPaymentIntent,
  fetchRefunds,
  sessionsForIntent,
} from '../../../../lib/api';
import { PaymentDetail } from '../../../../lib/payments-view';
import { normalizeLocale } from '../../../../messages';

export const dynamic = 'force-dynamic';

/**
 * Detalle de un pago con línea de tiempo derivada y recursos relacionados. Los
 * refunds llegan filtrados por el API (`?payment_intent_id=`); las sesiones se
 * filtran aquí (no existe endpoint por-intent — filtro puro sobre la lista).
 * Crear reembolso (F6.5A-bis) solo se ofrece a roles con reconciliation:manage.
 */
export default async function PaymentDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; paymentId: string }>;
  searchParams: Promise<{ lang?: string }>;
}) {
  const token = (await cookies()).get('fluvia_session')?.value;
  if (!token) redirect('/login');
  const { orgId, paymentId } = await params;
  const { lang } = await searchParams;
  const base = apiBase();
  const [intent, refunds, sessions, orgs] = await Promise.all([
    fetchPaymentIntent({ apiBase: base, token, orgId, paymentId }),
    fetchRefunds({ apiBase: base, token, orgId, paymentIntentId: paymentId }),
    fetchCheckoutSessions({ apiBase: base, token, orgId }),
    fetchOrganizations({ apiBase: base, token }),
  ]);
  if (!intent) notFound();
  const role = orgs.find((o) => o.organization_id === orgId)?.role;
  return (
    <PaymentDetail
      intent={intent}
      refunds={refunds}
      sessions={sessionsForIntent(sessions, paymentId)}
      orgId={orgId}
      locale={normalizeLocale(lang)}
      signOutHref="/logout"
      canManage={canManageReconciliation(role)}
    />
  );
}
