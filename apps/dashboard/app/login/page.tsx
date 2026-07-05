import { LoginForm } from './login-client';
import { normalizeLocale } from '../messages';

/** Página de login. El locale por `?lang=`; en Next 15 searchParams es promesa. */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ lang?: string }>;
}) {
  const { lang } = await searchParams;
  return <LoginForm locale={normalizeLocale(lang)} />;
}
