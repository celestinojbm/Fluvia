import { SignupForm } from './signup-client';
import { normalizeLocale } from '../messages';

/** Página de signup sandbox (F6.5C1). El locale por `?lang=`, como /login. */
export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ lang?: string }>;
}) {
  const { lang } = await searchParams;
  return <SignupForm locale={normalizeLocale(lang)} />;
}
