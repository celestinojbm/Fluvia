import { apiBase, fetchMerchants } from '../../../../lib/api';
import { orgContext } from '../../../../lib/org-context';
import {
  orgPath,
  readApi,
  type CatalogImage,
  type Category,
  type Product,
} from '../../../../lib/commerce-api';
import { ProductForm } from '../../../../lib/product-form';
import { CATALOG_ROLES, PageHead } from '../../../../lib/ui';

export const dynamic = 'force-dynamic';

export default async function NewProductPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ variant_of?: string }>;
}) {
  const { orgId } = await params;
  const { variant_of } = await searchParams;
  const { token, role } = await orgContext(orgId);
  const baseId = variant_of && /^[0-9a-f-]{36}$/i.test(variant_of) ? variant_of : null;
  const [categories, merchants, images, base] = await Promise.all([
    readApi<{ data: Category[] }>(token, orgPath(orgId, '/catalog/categories')),
    fetchMerchants({ apiBase: apiBase(), token, orgId }),
    readApi<{ data: CatalogImage[] }>(token, orgPath(orgId, '/catalog/images')),
    baseId
      ? readApi<Product>(token, orgPath(orgId, `/catalog/products/${baseId}`))
      : Promise.resolve(null),
  ]);
  const baseProduct = base && base.kind === 'ok' && !base.data.variant_of ? base.data : undefined;
  return (
    <main className="fx-page" aria-labelledby="np-title">
      <PageHead
        id="np-title"
        title={baseProduct ? `Nueva variante de ${baseProduct.name}` : 'Nuevo producto'}
        crumb={{ href: `/o/${orgId}/catalog`, label: 'Catálogo' }}
      />
      <section className="fx-panel" style={{ maxWidth: '46rem' }}>
        <div className="fx-panel-body">
          <ProductForm
            orgId={orgId}
            categories={categories.kind === 'ok' ? categories.data.data : []}
            defaultCurrency={merchants[0]?.defaultCurrency ?? 'USD'}
            canEdit={role !== undefined && CATALOG_ROLES.has(role)}
            images={images.kind === 'ok' ? images.data.data : []}
            base={baseProduct}
          />
        </div>
      </section>
    </main>
  );
}
