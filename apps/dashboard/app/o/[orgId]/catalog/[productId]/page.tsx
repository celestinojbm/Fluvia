import { orgContext } from '../../../../lib/org-context';
import {
  orgPath,
  readApi,
  type CatalogImage,
  type Category,
  type Movement,
  type Product,
} from '../../../../lib/commerce-api';
import { ProductThumb, StockBadge } from '../../../../lib/commerce-ui';
import { formatAmount } from '../../../../lib/money-format';
import { ProductForm } from '../../../../lib/product-form';
import { StockPanel } from '../../../../lib/stock-panel';
import { CATALOG_ROLES, Callout, PageHead, ReadProblem, dateTime } from '../../../../lib/ui';

export const dynamic = 'force-dynamic';

/** Ficha de producto: formulario | vista previa, variantes y existencias. */
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
  const [moves, categories, images, all] = await Promise.all([
    valid
      ? readApi<{ product: Product; data: Movement[] }>(
          token,
          orgPath(orgId, `/catalog/products/${productId}/movements`)
        )
      : Promise.resolve({ kind: 'not_found' } as const),
    readApi<{ data: Category[] }>(token, orgPath(orgId, '/catalog/categories')),
    readApi<{ data: CatalogImage[] }>(token, orgPath(orgId, '/catalog/images')),
    readApi<{ data: Product[] }>(token, orgPath(orgId, '/catalog/products?limit=500')),
  ]);
  const canEdit = role !== undefined && CATALOG_ROLES.has(role);
  const o = `/o/${orgId}`;
  const product = moves.kind === 'ok' ? moves.data.product : null;
  const family =
    product && all.kind === 'ok'
      ? all.data.data.filter(
          (p) =>
            p.id !== product.id &&
            (p.variant_of === (product.variant_of ?? product.id) || p.id === product.variant_of)
        )
      : [];
  const baseId = product ? (product.variant_of ?? product.id) : null;

  return (
    <main className="fx-page" aria-labelledby="p-title">
      <PageHead
        id="p-title"
        title={
          product
            ? `${product.name}${product.variant_label ? ` · ${product.variant_label}` : ''}`
            : 'Producto'
        }
        eyebrow={product ? (product.category_name ?? 'Sin categoría') : undefined}
        description={
          product
            ? `Versión ${product.version} · actualizado ${dateTime(product.updated_at)}`
            : undefined
        }
        crumb={{ href: `${o}/catalog`, label: 'Catálogo' }}
      />
      {moves.kind !== 'ok' || !product ? (
        <ReadProblem kind={moves.kind === 'ok' ? 'not_found' : moves.kind} what="este producto" />
      ) : (
        <>
          {created ? (
            <Callout tone="ok" role="status">
              <p>
                Producto creado. Ya aparece en «Nueva venta» si está disponible
                {product.track_stock ? ' y tiene existencias' : ''}.
              </p>
            </Callout>
          ) : null}
          <div className="fx-grid fx-grid-main">
            <section className="fx-panel" aria-label="Datos del producto">
              <div className="fx-panel-body">
                <ProductForm
                  orgId={orgId}
                  product={product}
                  categories={categories.kind === 'ok' ? categories.data.data : []}
                  defaultCurrency={product.currency}
                  canEdit={canEdit}
                  images={images.kind === 'ok' ? images.data.data : []}
                />
              </div>
            </section>
            <div className="fx-grid">
              <section className="fx-panel" aria-labelledby="preview-title">
                <div className="fx-panel-body">
                  <h2 id="preview-title" className="sr-only">
                    Vista previa
                  </h2>
                  <ProductThumb product={product} size="lg" />
                  <p style={{ margin: '12px 0 2px', fontWeight: 700 }}>
                    {product.name}
                    {product.variant_label ? ` · ${product.variant_label}` : ''}
                  </p>
                  <p className="fx-hero-value" style={{ fontSize: '1.6rem', marginTop: 0 }}>
                    {formatAmount(product.price, product.currency, 'es', { code: true })}
                  </p>
                  <StockBadge product={product} showUntracked />
                </div>
              </section>
              <StockPanel
                orgId={orgId}
                product={product}
                movements={moves.data.data}
                canEdit={canEdit}
              />
              <section className="fx-panel" aria-labelledby="family-title">
                <header>
                  <h2 id="family-title">Variantes</h2>
                  {canEdit && baseId ? (
                    <a className="fx-link" href={`${o}/catalog/new?variant_of=${baseId}`}>
                      Añadir variante
                    </a>
                  ) : null}
                </header>
                <div className="fx-panel-body">
                  {family.length === 0 ? (
                    <p className="fx-hint">
                      Sin variantes. Úsalas para presentaciones del mismo producto (250 g / 500 g,
                      tallas): cada una con su precio, SKU y existencias.
                    </p>
                  ) : (
                    <ul className="fx-feed">
                      {family.map((v) => (
                        <li key={v.id}>
                          <a href={`${o}/catalog/${v.id}`}>
                            {v.variant_label ?? v.name}
                            {v.id === product.variant_of ? ' (base)' : ''}
                          </a>
                          <span className="amt">{formatAmount(v.price, v.currency, 'es')}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </section>
            </div>
          </div>
        </>
      )}
    </main>
  );
}
