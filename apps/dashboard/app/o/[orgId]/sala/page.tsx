import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { orgPath, readApi } from '../../../lib/commerce-api';
import { Callout, PageHead, ReadProblem } from '../../../lib/ui';
import { SalaWorkspace } from '../../../lib/venue/sala';
import type { BusinessProfile, DiningOrder, VenueLayout } from '../../../lib/venue/api';
import '../../../venue.css';

export const dynamic = 'force-dynamic';

/** Sala: mesas, pedidos para llevar y pedidos por QR por aceptar. */
export default async function SalaPage({ params }: { params: Promise<{ orgId: string }> }) {
  const token = (await cookies()).get('fluvia_session')?.value;
  if (!token) redirect('/login');
  const { orgId } = await params;
  const [profile, layout] = await Promise.all([
    readApi<BusinessProfile>(token, orgPath(orgId, '/business-profile')),
    readApi<VenueLayout>(token, orgPath(orgId, '/venue')),
  ]);
  if (profile.kind !== 'ok') return <ReadProblem kind={profile.kind} what="tu negocio" />;
  if (layout.kind !== 'ok') return <ReadProblem kind={layout.kind} what="el local" />;
  const access = profile.data.my_access?.venue;
  const branches = layout.data.branches.filter(
    (b) =>
      access?.full ||
      access?.grants.some(
        (g) => (g.branch_id === null || g.branch_id === b.id) && g.role !== 'kitchen'
      )
  );
  const head = (
    <PageHead id="sala-title" title="Sala" description="Mesas, pedidos y cuentas en vivo." />
  );
  if (!branches.length) {
    // Solo cocina: su pantalla es el KDS.
    if (access?.grants.some((g) => g.role === 'kitchen')) redirect(`/o/${orgId}/cocina`);
    return (
      <section className="fx-page">
        {head}
        <Callout tone="info" title="Sin sala asignada">
          <p>
            {layout.data.branches.length
              ? 'Pide a un encargado que te asigne un rol de sala en una sucursal.'
              : 'Aún no hay sucursales. Configúralas en Negocio.'}
          </p>
        </Callout>
      </section>
    );
  }
  const first = branches[0]!;
  const orders = await readApi<{ data: DiningOrder[] }>(
    token,
    orgPath(orgId, `/dining/orders?branch_id=${first.id}`)
  );
  return (
    <section className="fx-page" aria-labelledby="sala-title">
      {head}
      <SalaWorkspace
        orgId={orgId}
        branches={branches}
        initialBranch={first.id}
        initialOrders={orders.kind === 'ok' ? orders.data.data : []}
        vocabulary={profile.data.vocabulary}
      />
    </section>
  );
}
