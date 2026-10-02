import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { apiBase, fetchMerchants } from '../../../lib/api';
import { orgPath, readApi } from '../../../lib/commerce-api';
import { PageHead, ReadProblem } from '../../../lib/ui';
import { CobrarWorkspace } from '../../../lib/venue/cobrar';
import type { BusinessProfile, Enablement } from '../../../lib/venue/api';
import '../../../venue.css';

export const dynamic = 'force-dynamic';

/**
 * «Cobrar» del independiente: pantalla móvil sin tienda, catálogo ni mesas.
 * Server-side: sesión, perfil (permisos efectivos) y habilitación de cobro;
 * el teléfono solo prepara el cobro y el servidor fija el resultado.
 */
export default async function CobrarPage({ params }: { params: Promise<{ orgId: string }> }) {
  const token = (await cookies()).get('fluvia_session')?.value;
  if (!token) redirect('/login');
  const { orgId } = await params;
  const [profile, enablement, merchants] = await Promise.all([
    readApi<BusinessProfile>(token, orgPath(orgId, '/business-profile')),
    readApi<Enablement>(token, orgPath(orgId, '/collection-enablement')),
    fetchMerchants({ apiBase: apiBase(), token, orgId }),
  ]);
  if (profile.kind !== 'ok') return <ReadProblem kind={profile.kind} what="tu negocio" />;
  if (enablement.kind !== 'ok')
    return <ReadProblem kind={enablement.kind} what="la habilitación" />;
  const merchant = merchants.find((m) => m.status === 'active') ?? null;
  const currencies = [...new Set([merchant?.defaultCurrency ?? 'USD', 'USD'])];
  return (
    <section className="fx-page vn-narrow" aria-labelledby="cobrar-title">
      <PageHead
        id="cobrar-title"
        title="Cobrar"
        description="Importe, moneda y concepto. El resultado lo confirma el proveedor, no esta pantalla."
      />
      <CobrarWorkspace
        orgId={orgId}
        merchantId={merchant?.id ?? null}
        currencies={currencies}
        enablement={enablement.data}
        sandbox={enablement.data.provider === 'sandbox_simulator'}
        canConfigure={profile.data.my_access?.can_configure ?? false}
      />
    </section>
  );
}
