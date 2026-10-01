import { apiBase, fetchMerchants } from '../../../../lib/api';
import { orgContext } from '../../../../lib/org-context';
import { orgPath, readApi, type Category } from '../../../../lib/commerce-api';
import { ProductForm } from '../../../../lib/product-form';
import { CATALOG_ROLES, PageHead } from '../../../../lib/ui';

export const dynamic = 'force-dynamic';

export default async function NewProductPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { token, role } = await orgContext(orgId);
  const [categories, merchants] = await Promise.all([
    readApi<{ data: Category[] }>(token, orgPath(orgId, '/catalog/categories')),
    fetchMerchants({ apiBase: apiBase(), token, orgId }),
  ]);
  return (
    <main className="fx-page" aria-labelledby="np-title">
      <PageHead
        id="np-title"
        title="Nuevo producto"
        crumb={{ href: `/o/${orgId}/catalog`, label: 'Catálogo' }}
      />
      <section className="fx-panel" style={{ maxWidth: '44rem' }}>
        <div className="fx-panel-body">
          <ProductForm
            orgId={orgId}
            categories={categories.kind === 'ok' ? categories.data.data : []}
            defaultCurrency={merchants[0]?.defaultCurrency ?? 'USD'}
            canEdit={role !== undefined && CATALOG_ROLES.has(role)}
          />
        </div>
      </section>
    </main>
  );
}
