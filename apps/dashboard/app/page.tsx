import { cookies } from 'next/headers';
import { FluviaLogo } from './lib/brand';
import { apiBase, fetchOrganizations } from './lib/api';
import { Landing } from './lib/landing';
import { NoOrgCta } from './lib/no-org-cta';
import { OrgList } from './lib/org-list';
import { MESSAGES, normalizeLocale } from './messages';

export const dynamic = 'force-dynamic';

/**
 * Raíz. Sin sesión de comercio: la PRESENTACIÓN pública (portada). Con sesión:
 * elige organización (la membresía del operador) y enlaza a `/o/{orgId}`. Lee
 * la cookie server-side; el token nunca llega al navegador.
 */
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ lang?: string }>;
}) {
  const token = (await cookies()).get('fluvia_session')?.value;
  if (!token) return <Landing />;
  const { lang } = await searchParams;
  const locale = normalizeLocale(lang);
  const t = MESSAGES[locale];
  const orgs = await fetchOrganizations({ apiBase: apiBase(), token });

  return (
    <main className="picker" aria-labelledby="orgs-title">
      <p className="auth-brand">
        <FluviaLogo height={26} />
      </p>
      <h1 id="orgs-title">{t.orgsTitle}</h1>
      {orgs.length === 0 ? <NoOrgCta locale={locale} /> : <OrgList orgs={orgs} locale={locale} />}
      <p>
        <a className="signout" href="/logout">
          {t.signOut}
        </a>
      </p>
    </main>
  );
}
