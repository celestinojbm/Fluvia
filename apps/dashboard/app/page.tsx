import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { apiBase, fetchOrganizations } from './lib/api';
import { NoOrgCta } from './lib/no-org-cta';
import { OrgList } from './lib/org-list';
import { MESSAGES, normalizeLocale } from './messages';

export const dynamic = 'force-dynamic';

/**
 * Raíz: elige organización. Lee la cookie de sesión server-side; sin sesión →
 * `/login`. Con sesión, lista las organizaciones del operador (su membresía) y
 * enlaza a `/o/{orgId}`. El token nunca llega al navegador.
 */
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ lang?: string }>;
}) {
  const token = (await cookies()).get('fluvia_session')?.value;
  if (!token) redirect('/login');
  const { lang } = await searchParams;
  const locale = normalizeLocale(lang);
  const t = MESSAGES[locale];
  const orgs = await fetchOrganizations({ apiBase: apiBase(), token });

  return (
    <main className="picker" aria-labelledby="orgs-title">
      <h1 id="orgs-title">{t.orgsTitle}</h1>
      {orgs.length === 0 ? (
        <NoOrgCta locale={locale} />
      ) : (
        <OrgList orgs={orgs} locale={locale} />
      )}
      <p>
        <a className="signout" href="/logout">
          {t.signOut}
        </a>
      </p>
    </main>
  );
}
