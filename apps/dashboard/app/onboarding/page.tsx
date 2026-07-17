import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { OnboardingWizard } from './onboarding-client';
import { resolveMerchantState, selectOnboardingOrganization } from './resolve';
import { apiBase, fetchMerchants, fetchOrganizations } from '../lib/api';
import { normalizeLocale } from '../messages';

export const dynamic = 'force-dynamic';

/**
 * Onboarding sandbox (F6.5C2): requiere sesion (cookie httpOnly server-side;
 * sin sesion → /login). Recuperacion DURABLE: el estado existente se resuelve
 * AQUI, server-side, con las lecturas existentes (`GET /v1/organizations` +
 * `GET /v1/organizations/:orgId/merchants`) — un reload, un cambio de pestana
 * o volver desde el dashboard retoman el paso correcto sin recrear filas ni
 * depender del estado del componente. `?orgId=` solo selecciona una
 * organizacion que pertenezca a la lista OWNER del propio usuario (un orgId
 * ajeno/inexistente se ignora, fail-safe sin fuga). El wizard llama SOLO a
 * los proxies BFF; el token de sesion jamas llega al navegador.
 */
export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ lang?: string; orgId?: string }>;
}) {
  const token = (await cookies()).get('fluvia_session')?.value;
  if (!token) redirect('/login');
  const { lang, orgId } = await searchParams;
  const locale = normalizeLocale(lang);

  const orgs = await fetchOrganizations({ apiBase: apiBase(), token });
  const initialOrganization = selectOnboardingOrganization(orgs, orgId);

  let initialMerchant = null;
  let notApplicable = false;
  if (initialOrganization) {
    const merchants = await fetchMerchants({
      apiBase: apiBase(),
      token,
      orgId: initialOrganization.id,
    });
    ({ initialMerchant, notApplicable } = resolveMerchantState(merchants));
  }

  return (
    <OnboardingWizard
      locale={locale}
      initialOrganization={initialOrganization}
      initialMerchant={initialMerchant}
      onboardingNotApplicable={notApplicable}
    />
  );
}
