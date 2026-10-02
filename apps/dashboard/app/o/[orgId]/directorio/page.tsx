import { CATEGORIES } from '../../../lib/categories';
import { orgPath, readApi } from '../../../lib/commerce-api';
import { DirectoryEditor, type OwnProfile } from '../../../lib/directory-editor';
import { orgContext } from '../../../lib/org-context';
import { PRESENTATION_CREDITS } from '../../../lib/presentation-credits';
import { CATALOG_ROLES, Callout, Empty, PageHead } from '../../../lib/ui';
import type { Merchant } from '../../../lib/api';

export const dynamic = 'force-dynamic';

/**
 * Perfil público en «Dónde comprar», por comercio de la organización. Un perfil
 * solo se ve si el comercio lo PUBLICA (confirmación explícita); se puede
 * retirar en cualquier momento.
 */
export default async function DirectoryPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { token, role } = await orgContext(orgId);
  const canEdit = role !== undefined && CATALOG_ROLES.has(role);
  const [merchants, profiles] = await Promise.all([
    readApi<{ merchants?: Merchant[] }>(token, orgPath(orgId, '/merchants')),
    readApi<{ data: OwnProfile[] }>(token, orgPath(orgId, '/directory/profiles')),
  ]);
  const failed = merchants.kind !== 'ok' || profiles.kind !== 'ok';
  const list = merchants.kind === 'ok' ? (merchants.data.merchants ?? []) : [];
  const byMerchant = new Map(
    (profiles.kind === 'ok' ? profiles.data.data : []).map((p) => [p.merchant_id, p])
  );
  const photos = PRESENTATION_CREDITS.map((p) => ({ ref: p.ref, label: p.label }));

  return (
    <main className="fx-page" aria-labelledby="dir-title">
      <PageHead
        id="dir-title"
        title="Directorio"
        description="Tu perfil en «Dónde comprar». Solo es visible si lo publicas, y puedes retirarlo cuando quieras."
      />
      {failed ? (
        <Callout tone="bad" title="No pudimos cargar tus perfiles" role="alert">
          <p>Es un fallo temporal. Recarga la página; no se ha cambiado nada.</p>
        </Callout>
      ) : list.length === 0 ? (
        <Empty title="No hay comercios en esta organización">
          <p>Crea un comercio en la puesta en marcha para poder publicar su perfil.</p>
        </Empty>
      ) : (
        <div className="fx-grid">
          {list
            .filter((m) => m.status === 'active')
            .map((m) => (
              <DirectoryEditor
                key={m.id}
                orgId={orgId}
                merchantId={m.id}
                merchantName={m.name}
                profile={byMerchant.get(m.id) ?? null}
                canEdit={canEdit}
                categories={CATEGORIES.map((c) => ({ slug: c.slug, label: c.label }))}
                photos={photos}
              />
            ))}
        </div>
      )}
    </main>
  );
}
