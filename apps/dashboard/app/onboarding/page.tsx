import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { OnboardingWizard } from './onboarding-client';
import { InvalidSelectionPanel, OrgSelectionPanel, ReadErrorPanel } from './onboarding-panels';
import { resolveMerchantState, resolveOnboardingOrganization } from './resolve';
import { apiBase } from '../lib/api';
import { readMerchants, readOrganizations } from '../lib/onboarding-reads';
import { normalizeLocale } from '../messages';

export const dynamic = 'force-dynamic';

/**
 * Onboarding sandbox (F6.5C2): requiere sesion (cookie httpOnly server-side;
 * sin sesion → /login). Recuperacion DURABLE resuelta AQUI, server-side, con
 * lecturas ESTRICTAS fail-closed (RA-F65C2-EXT-003): un fallo de lectura
 * (HTTP/red/JSON/shape) JAMAS se muestra como estado vacio ni habilita un
 * formulario de mutacion — se renderiza un estado recuperable con reintento;
 * un 401 sigue el patron existente y redirige a /login. La seleccion de
 * organizacion es EXPLICITA (RA-F65C2-EXT-002): sin fallback silencioso, con
 * selector cuando hay varias owner y estado invalido generico ante un
 * `orgId` que no pertenece a las organizaciones owner de la sesion (sin leer
 * merchants en ese caso). El wizard llama SOLO a los proxies BFF; el token de
 * sesion jamas llega al navegador.
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

  const orgsRead = await readOrganizations({ apiBase: apiBase(), token });
  if (!orgsRead.ok) {
    if (orgsRead.kind === 'unauthorized') redirect('/login');
    return <ReadErrorPanel locale={locale} retryOrgId={orgId} />;
  }

  const resolution = resolveOnboardingOrganization(orgsRead.value, orgId);
  if (resolution.kind === 'new_onboarding') {
    return <OnboardingWizard locale={locale} />;
  }
  if (resolution.kind === 'selection_required') {
    return <OrgSelectionPanel options={resolution.options} locale={locale} />;
  }
  if (resolution.kind === 'invalid_selection') {
    // Sin fallback y SIN lectura de merchants: cero datos de una seleccion
    // invalida, mensaje generico que no revela si el ID existe.
    return <InvalidSelectionPanel options={resolution.options} locale={locale} />;
  }

  const merchantsRead = await readMerchants({
    apiBase: apiBase(),
    token,
    orgId: resolution.organization.id,
  });
  if (!merchantsRead.ok) {
    if (merchantsRead.kind === 'unauthorized') redirect('/login');
    // Conserva la seleccion valida en el reintento; jamas «Paso 2 vacio».
    return <ReadErrorPanel locale={locale} retryOrgId={resolution.organization.id} />;
  }

  const { initialMerchant, notApplicable } = resolveMerchantState(merchantsRead.value);
  return (
    <OnboardingWizard
      locale={locale}
      initialOrganization={resolution.organization}
      initialMerchant={initialMerchant}
      onboardingNotApplicable={notApplicable}
    />
  );
}
