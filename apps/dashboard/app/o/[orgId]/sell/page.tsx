import { apiBase, fetchMerchants } from '../../../lib/api';
import { orgContext } from '../../../lib/org-context';
import { orgPath, readApi, type Category, type Product } from '../../../lib/commerce-api';
import { SellWorkspace } from '../../../lib/sell-workspace';
import { PageHead, ReadProblem, SELL_ROLES } from '../../../lib/ui';

export const dynamic = 'force-dynamic';

/** Nueva venta: catálogo vendible (disponible, no archivado) + carrito. */
export default async function SellPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { token, role } = await orgContext(orgId);
  const [products, categories, merchants] = await Promise.all([
    readApi<{ data: Product[] }>(
      token,
      orgPath(orgId, '/catalog/products?sellable=true&limit=500')
    ),
    readApi<{ data: Category[] }>(token, orgPath(orgId, '/catalog/categories')),
    fetchMerchants({ apiBase: apiBase(), token, orgId }),
  ]);
  return (
    <main className="fx-page" aria-labelledby="sell-title">
      <PageHead
        id="sell-title"
        title="Nueva venta"
        description="Elige productos, revisa el total y registra la venta. Después se cobra con el terminal."
      />
      {products.kind !== 'ok' ? (
        <ReadProblem kind={products.kind} what="el catálogo" />
      ) : (
        <SellWorkspace
          orgId={orgId}
          products={products.data.data}
          categories={
            categories.kind === 'ok' ? categories.data.data.filter((c) => c.product_count > 0) : []
          }
          merchants={merchants.filter((m) => m.status === 'active')}
          canSell={role !== undefined && SELL_ROLES.has(role)}
        />
      )}
    </main>
  );
}
