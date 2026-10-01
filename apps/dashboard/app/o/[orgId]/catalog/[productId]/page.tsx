import { orgContext } from '../../../../lib/org-context';
import { orgPath, readApi, type Category, type Product } from '../../../../lib/commerce-api';
import { ProductForm } from '../../../../lib/product-form';
import { CATALOG_ROLES, Callout, PageHead, ReadProblem, dateTime } from '../../../../lib/ui';

export const dynamic = 'force-dynamic';

export default async function ProductPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; productId: string }>;
  searchParams: Promise<{ created?: string }>;
}) {
  const { orgId, productId } = await params;
  const { created } = await searchParams;
  const { token, role } = await orgContext(orgId);
  const valid = /^[0-9a-f-]{36}$/i.test(productId);
  const [product, categories] = await Promise.all([
    valid
      ? readApi<Product>(token, orgPath(orgId, `/catalog/products/${productId}`))
      : Promise.resolve({ kind: 'not_found' } as const),
    readApi<{ data: Category[] }>(token, orgPath(orgId, '/catalog/categories')),
  ]);
  return (
    <main className="fx-page" aria-labelledby="p-title">
      <PageHead
        id="p-title"
        title={product.kind === 'ok' ? product.data.name : 'Producto'}
        description={
          product.kind === 'ok'
            ? `Versión ${product.data.version} · actualizado ${dateTime(product.data.updated_at)}`
            : undefined
        }
        crumb={{ href: `/o/${orgId}/catalog`, label: 'Catálogo' }}
      />
      {product.kind !== 'ok' ? (
        <ReadProblem kind={product.kind} what="este producto" />
      ) : (
        <>
          {created ? (
            <Callout tone="ok" role="status">
              <p>Producto creado. Ya aparece en «Nueva venta» si está disponible.</p>
            </Callout>
          ) : null}
          <section className="fx-panel" style={{ maxWidth: '44rem' }}>
            <div className="fx-panel-body">
              <ProductForm
                orgId={orgId}
                product={product.data}
                categories={categories.kind === 'ok' ? categories.data.data : []}
                defaultCurrency={product.data.currency}
                canEdit={role !== undefined && CATALOG_ROLES.has(role)}
              />
            </div>
          </section>
        </>
      )}
    </main>
  );
}
