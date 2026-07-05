import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { apiBase, fetchOrganizations } from './lib/api';
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
        <p className="empty">{t.noOrgs}</p>
      ) : (
        <ul className="org-list">
          {orgs.map((o) => (
            <li key={o.organization_id}>
              <a href={`/o/${o.organization_id}`}>
                <span className="org-name">{o.name}</span>
                <span className="org-role">{o.role}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
      <p>
        <a className="signout" href="/logout">
          {t.signOut}
        </a>
      </p>
    </main>
  );
}
