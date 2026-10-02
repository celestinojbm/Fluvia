import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { orgPath, readApi, type Member, type Product } from '../../../lib/commerce-api';
import { Callout, PageHead, ReadProblem } from '../../../lib/ui';
import { NegocioWorkspace, type StaffRow } from '../../../lib/venue/negocio';
import type { BusinessProfile, Enablement, VenueLayout } from '../../../lib/venue/api';
import '../../../venue.css';

export const dynamic = 'force-dynamic';

/** Configuración del negocio: tipo, módulos, habilitación, local, menú y personal. */
export default async function NegocioPage({ params }: { params: Promise<{ orgId: string }> }) {
  const token = (await cookies()).get('fluvia_session')?.value;
  if (!token) redirect('/login');
  const { orgId } = await params;
  const profile = await readApi<BusinessProfile>(token, orgPath(orgId, '/business-profile'));
  if (profile.kind !== 'ok') return <ReadProblem kind={profile.kind} what="tu negocio" />;
  if (!profile.data.my_access?.can_configure) {
    return (
      <section className="fx-page">
        <PageHead id="neg-title" title="Negocio" />
        <Callout tone="info" title="Solo propietarios y administradores">
          <p>Tu rol puede usar las pantallas de trabajo, pero no cambiar la configuración.</p>
        </Callout>
      </section>
    );
  }
  const [enablement, layout, products, members, staff] = await Promise.all([
    readApi<Enablement>(token, orgPath(orgId, '/collection-enablement')),
    readApi<VenueLayout>(token, orgPath(orgId, '/venue')),
    readApi<{ data: Product[] }>(token, orgPath(orgId, '/catalog/products?limit=200')),
    readApi<{ members: Member[] }>(token, orgPath(orgId, '/members')),
    readApi<{ data: StaffRow[] }>(token, orgPath(orgId, '/venue/staff')),
  ]);
  if (enablement.kind !== 'ok')
    return <ReadProblem kind={enablement.kind} what="la habilitación" />;
  if (layout.kind !== 'ok') return <ReadProblem kind={layout.kind} what="el local" />;
  return (
    <section className="fx-page" aria-labelledby="neg-title">
      <PageHead
        id="neg-title"
        title="Negocio"
        description="Tipo de negocio, módulos, cobro presencial, local, menú y personal."
      />
      <NegocioWorkspace
        orgId={orgId}
        profile={profile.data}
        enablement={enablement.data}
        layout={layout.data}
        products={
          products.kind === 'ok'
            ? products.data.data
                .filter((p) => !p.archived)
                .map((p) => ({ id: p.id, name: p.name, price: p.price, currency: p.currency }))
            : []
        }
        members={members.kind === 'ok' ? members.data.members : []}
        staff={staff.kind === 'ok' ? staff.data.data : []}
      />
    </section>
  );
}
