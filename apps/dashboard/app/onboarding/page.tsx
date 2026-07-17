import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { OnboardingWizard } from './onboarding-client';
import { normalizeLocale } from '../messages';

export const dynamic = 'force-dynamic';

/**
 * Onboarding sandbox (F6.5C2): requiere sesion (cookie httpOnly server-side;
 * sin sesion → /login). El wizard llama SOLO a los proxies BFF; el token de
 * sesion jamas llega al navegador. El locale por `?lang=`, como /login.
 */
export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ lang?: string }>;
}) {
  const token = (await cookies()).get('fluvia_session')?.value;
  if (!token) redirect('/login');
  const { lang } = await searchParams;
  return <OnboardingWizard locale={normalizeLocale(lang)} />;
}
