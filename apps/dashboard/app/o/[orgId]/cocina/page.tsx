import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { orgPath, readApi } from '../../../lib/commerce-api';
import { Callout, PageHead, ReadProblem } from '../../../lib/ui';
import { KitchenDisplay } from '../../../lib/venue/kds';
import type { BusinessProfile, VenueLayout } from '../../../lib/venue/api';
import '../../../venue.css';

export const dynamic = 'force-dynamic';

/** KDS: comandas por estación en vivo (tablet o monitor). */
export default async function CocinaPage({ params }: { params: Promise<{ orgId: string }> }) {
  const token = (await cookies()).get('fluvia_session')?.value;
  if (!token) redirect('/login');
  const { orgId } = await params;
  const [profile, layout] = await Promise.all([
    readApi<BusinessProfile>(token, orgPath(orgId, '/business-profile')),
    readApi<VenueLayout>(token, orgPath(orgId, '/venue')),
  ]);
  if (profile.kind !== 'ok') return <ReadProblem kind={profile.kind} what="tu negocio" />;
  if (layout.kind !== 'ok') return <ReadProblem kind={layout.kind} what="el local" />;
  if (!profile.data.modules.includes('kitchen')) {
    return (
      <section className="fx-page">
        <PageHead id="kds-title" title="Cocina" />
        <Callout tone="info" title="El módulo Cocina no está activo">
          <p>Actívalo en Negocio para recibir comandas en esta pantalla.</p>
        </Callout>
      </section>
    );
  }
  const access = profile.data.my_access?.venue;
  // Solo las sucursales donde el usuario tiene cocina o es encargado/completo.
  const allowed = layout.data.branches.filter(
    (b) =>
      access?.full ||
      access?.grants.some(
        (g) =>
          (g.branch_id === null || g.branch_id === b.id) && ['kitchen', 'manager'].includes(g.role)
      )
  );
  if (!allowed.length) {
    return (
      <section className="fx-page">
        <PageHead id="kds-title" title="Cocina" />
        <Callout tone="info" title="Sin acceso a cocina">
          <p>Pide a un encargado que te asigne el rol Cocina en una sucursal.</p>
        </Callout>
      </section>
    );
  }
  const canRecall = !!access?.full || !!access?.grants.some((g) => g.role === 'manager');
  return (
    <KitchenDisplay
      orgId={orgId}
      canRecall={canRecall}
      branches={allowed.map((b) => ({
        id: b.id,
        name: b.name,
        stations: b.stations.map((s) => ({ code: s.code, name: s.name })),
      }))}
    />
  );
}
