import type { ReactNode } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { AppShell, type NavProfile } from '../../lib/app-shell';
import { orgPath, readApi, type Member, type SessionInfo } from '../../lib/commerce-api';
import { roleLabel } from '../../lib/ui';
import '../../platform.css';
import '../../lib/rates.css';
import { loadFx } from '../../lib/fx-server';
import { FxProvider } from '../../lib/fx-ui';

export const dynamic = 'force-dynamic';

/**
 * Estructura común de TODAS las pantallas de una organización. Server-side:
 *  - sin cookie ⇒ /login;
 *  - sesión caducada (401) ⇒ pantalla propia con enlace a iniciar sesión (no
 *    una lista vacía que parezca «sin datos»);
 *  - organización ajena o inexistente ⇒ «sin acceso» (indistinguibles).
 * El rol mostrado viene de la membresía; el API sigue siendo quien autoriza.
 */
export default async function OrgLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ orgId: string }>;
}) {
  const token = (await cookies()).get('fluvia_session')?.value;
  if (!token) redirect('/login');
  const { orgId } = await params;

  const session = await readApi<SessionInfo>(token, '/v1/auth/session');
  if (session.kind === 'unauthorized') {
    return (
      <main className="auth" aria-labelledby="expired-title">
        <h1 id="expired-title">Tu sesión caducó</h1>
        <p>Por seguridad, las sesiones expiran. Vuelve a iniciar sesión para continuar.</p>
        <p>
          <a className="fx-btn fx-btn-primary" href="/logout">
            Iniciar sesión de nuevo
          </a>
        </p>
      </main>
    );
  }
  if (session.kind !== 'ok') {
    return (
      <main className="auth" aria-labelledby="down-title">
        <h1 id="down-title">No pudimos conectar con Fluvia</h1>
        <p>El servicio no respondió. Recarga la página en unos segundos.</p>
      </main>
    );
  }
  const membership = session.data.memberships.find((m) => m.organization_id === orgId);
  if (!membership) {
    return (
      <main className="auth" aria-labelledby="noaccess-title">
        <h1 id="noaccess-title">Sin acceso a esta organización</h1>
        <p>No existe o no eres miembro. Elige una de tus organizaciones.</p>
        <p>
          <a className="fx-btn fx-btn-primary" href="/">
            Mis organizaciones
          </a>
        </p>
      </main>
    );
  }

  const [members, biz, fx] = await Promise.all([
    readApi<{ members: Member[] }>(token, orgPath(orgId, '/members')),
    readApi<{ business_type: NavProfile['businessType']; modules: string[] }>(
      token,
      orgPath(orgId, '/business-profile')
    ),
    loadFx(),
  ]);
  const email =
    members.kind === 'ok'
      ? (members.data.members.find((m) => m.user_id === session.data.user_id)?.email ?? null)
      : null;

  return (
    <FxProvider initialRates={fx.rates} initialDisplay={fx.display}>
      <AppShell
        orgId={orgId}
        orgName={membership.organization_name}
        roleLabel={roleLabel(membership.role)}
        userEmail={email}
        profile={
          biz.kind === 'ok'
            ? {
                businessType: biz.data.business_type,
                modules: biz.data.modules,
                role: membership.role,
              }
            : { businessType: 'retail', modules: [], role: membership.role }
        }
      >
        {children}
      </AppShell>
    </FxProvider>
  );
}
