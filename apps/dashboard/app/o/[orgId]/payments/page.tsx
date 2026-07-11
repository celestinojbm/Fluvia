import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { apiBase, fetchPaymentIntents } from '../../../lib/api';
import { PaymentsList } from '../../../lib/payments-view';
import { normalizeLocale } from '../../../messages';

export const dynamic = 'force-dynamic';

/** Lista de pagos (payment intents) de la organización — lectura por sesión. */
export default async function PaymentsPage({
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
  const intents = await fetchPaymentIntents({ apiBase: apiBase(), token, orgId });
  return (
    <PaymentsList
      intents={intents}
      orgId={orgId}
      locale={normalizeLocale(lang)}
      signOutHref="/logout"
    />
  );
}
