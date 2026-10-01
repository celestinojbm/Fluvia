'use client';

import { useMemo, useRef, useState } from 'react';
import { displayExponent, formatAmount } from '../messages';
import { clientCall, errorMessage } from './client-call';
import type { CatalogImage, Category, Product } from './commerce-api';
import { ProductThumb } from './commerce-ui';
import { POS_CURRENCIES, parseMajorAmount } from './pos-money';

/**
 * Alta y edición de producto. Precio en unidades MAYORES con la misma regla
 * que el POS (`parseMajorAmount`, sin floats); la API recibe unidades menores.
 * Edición con versión esperada: si otra persona lo cambió, se avisa y no se
 * pisa. Doble envío bloqueado (candado + botón deshabilitado).
 */

type Phase =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'error'; message: string; conflict?: boolean }
  | { kind: 'saved'; product: Product };

function majorText(minor: number, currency: string): string {
  const exp = displayExponent(currency);
  if (exp === 0) return String(minor);
  const s = String(minor).padStart(3, '0');
  return `${s.slice(0, -2)}.${s.slice(-2)}`;
}

export function ProductForm({
  orgId,
  categories: initialCategories,
  product,
  defaultCurrency,
  canEdit,
  images = [],
  base,
}: {
  orgId: string;
  categories: Category[];
  product?: Product;
  defaultCurrency: string;
  canEdit: boolean;
  /** Galería cerrada de imágenes de demostración (origen y licencia en la API). */
  images?: CatalogImage[];
  /** Alta de una VARIANTE de este producto base (misma moneda, se fija al crear). */
  base?: Product;
}) {
  const editing = product !== undefined;
  const [imageRef, setImageRef] = useState<string | null>(
    product?.image_ref ?? base?.image_ref ?? null
  );
  const [variantLabel, setVariantLabel] = useState(product?.variant_label ?? '');
  const [trackStock, setTrackStock] = useState(product?.track_stock ?? base?.track_stock ?? false);
  const isVariant = Boolean(base || product?.variant_of);
  const [name, setName] = useState(product?.name ?? base?.name ?? '');
  const [sku, setSku] = useState(product?.sku ?? '');
  const [description, setDescription] = useState(product?.description ?? '');
  const [categoryId, setCategoryId] = useState(product?.category_id ?? base?.category_id ?? '');
  const [currency, setCurrency] = useState(product?.currency ?? base?.currency ?? defaultCurrency);
  const [priceText, setPriceText] = useState(
    product ? majorText(product.price, product.currency) : ''
  );
  const [available, setAvailable] = useState(product?.available ?? true);
  const [categories, setCategories] = useState(initialCategories);
  const [newCategory, setNewCategory] = useState('');
  const [catMsg, setCatMsg] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [current, setCurrent] = useState<Product | undefined>(product);
  const lock = useRef(false);
  const alertRef = useRef<HTMLDivElement>(null);

  const price = useMemo(() => parseMajorAmount(priceText, currency), [priceText, currency]);
  const nameError = touched && name.trim() === '' ? 'Escribe el nombre del producto.' : null;
  const variantError =
    touched && isVariant && variantLabel.trim() === ''
      ? 'Escribe la etiqueta de la variante (ej. 500 g, talla M).'
      : null;
  const priceError =
    touched && !price.ok
      ? price.error === 'decimals'
        ? `Esta moneda admite ${displayExponent(currency)} decimales.`
        : price.error === 'too_large'
          ? 'Importe demasiado grande.'
          : 'Escribe un precio mayor que cero (ej. 12.50).'
      : null;

  const o = encodeURIComponent(orgId);

  async function addCategory() {
    const n = newCategory.trim();
    if (!n) return;
    setCatMsg(null);
    const r = await clientCall<Category>(`/api/orgs/${o}/catalog/categories`, {
      method: 'POST',
      body: { name: n },
    });
    if (r.kind === 'ok') {
      setCategories((cs) => [...cs, r.body].sort((a, b) => a.name.localeCompare(b.name)));
      setCategoryId(r.body.id);
      setNewCategory('');
      setCatMsg(`Categoría «${r.body.name}» creada y seleccionada.`);
    } else {
      setCatMsg(errorMessage(r));
    }
  }

  async function submit(extra?: { archived: boolean }) {
    setTouched(true);
    if (lock.current) return;
    if (!extra && (name.trim() === '' || !price.ok || variantError !== null)) return;
    if (!extra && isVariant && variantLabel.trim() === '') return;
    lock.current = true;
    setPhase({ kind: 'saving' });
    try {
      const r = editing
        ? await clientCall<Product>(`/api/orgs/${o}/catalog/products/${current!.id}`, {
            method: 'PATCH',
            body: extra
              ? { archived: extra.archived, expected_version: current!.version }
              : {
                  name: name.trim(),
                  sku: sku.trim() || null,
                  description: description.trim() || null,
                  category_id: categoryId || null,
                  price: price.ok ? price.minor : undefined,
                  available,
                  image_ref: imageRef,
                  variant_label: variantLabel.trim() || null,
                  track_stock: trackStock,
                  expected_version: current!.version,
                },
          })
        : await clientCall<Product>(`/api/orgs/${o}/catalog/products`, {
            method: 'POST',
            body: {
              name: name.trim(),
              sku: sku.trim() || null,
              description: description.trim() || null,
              category_id: categoryId || null,
              price: price.ok ? price.minor : 0,
              currency,
              available,
              image_ref: imageRef,
              variant_label: variantLabel.trim() || null,
              track_stock: trackStock,
              ...(base ? { variant_of: base.id } : {}),
            },
          });
      if (r.kind === 'ok') {
        setCurrent(r.body);
        setPhase({ kind: 'saved', product: r.body });
        if (!editing) {
          window.location.assign(`/o/${orgId}/catalog/${r.body.id}?created=1`);
        }
      } else {
        setPhase({
          kind: 'error',
          message: errorMessage(r),
          conflict: r.kind === 'http' && r.code === 'catalog_version_conflict',
        });
      }
    } finally {
      lock.current = false;
      setTimeout(() => alertRef.current?.focus(), 0);
    }
  }

  const busy = phase.kind === 'saving';
  const disabled = !canEdit || busy;

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      aria-describedby={!canEdit ? 'perm-note' : undefined}
    >
      {!canEdit ? (
        <p id="perm-note" className="fx-callout" data-tone="info">
          Solo propietarios y administradores editan el catálogo. Puedes consultarlo.
        </p>
      ) : null}
      <div ref={alertRef} tabIndex={-1} aria-live="polite">
        {phase.kind === 'error' ? (
          <div className="fx-callout" data-tone="bad" role="alert">
            <div>
              <p>{phase.message}</p>
              {phase.conflict ? (
                <p>
                  <a href={`/o/${orgId}/catalog/${current?.id ?? ''}`}>
                    Recargar la versión actual
                  </a>
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
        {phase.kind === 'saved' && editing ? (
          <div className="fx-callout" data-tone="ok" role="status">
            <p>
              Cambios guardados (versión {phase.product.version}).{' '}
              {phase.product.archived ? 'El producto está archivado: no aparece al vender.' : ''}
              Las ventas ya hechas conservan su precio original.
            </p>
          </div>
        ) : null}
      </div>

      <div className="fx-field">
        <label htmlFor="p-name">Nombre</label>
        <input
          id="p-name"
          className="fx-input"
          value={name}
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
          aria-invalid={nameError ? true : undefined}
          aria-describedby={nameError ? 'p-name-err' : undefined}
          disabled={disabled}
          required
        />
        {nameError ? (
          <p id="p-name-err" className="fx-error-text">
            {nameError}
          </p>
        ) : null}
      </div>

      {isVariant || variantLabel ? (
        <div className="fx-field">
          <label htmlFor="p-variant">
            {isVariant ? 'Etiqueta de la variante' : 'Presentación (opcional)'}
          </label>
          <input
            id="p-variant"
            className="fx-input"
            value={variantLabel}
            maxLength={40}
            onChange={(e) => setVariantLabel(e.target.value)}
            aria-invalid={variantError ? true : undefined}
            aria-describedby={variantError ? 'p-variant-err p-variant-hint' : 'p-variant-hint'}
            disabled={disabled}
            placeholder="500 g · 1 L · talla M"
          />
          <p id="p-variant-hint" className="fx-hint">
            {base
              ? `Variante de «${base.name}». Tiene su propio precio, SKU y existencias; la moneda es la del producto base.`
              : 'Se muestra junto al nombre al vender y en el justificante.'}
          </p>
          {variantError ? (
            <p id="p-variant-err" className="fx-error-text">
              {variantError}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="fx-row">
        <div className="fx-field">
          <label htmlFor="p-price">Precio</label>
          <input
            id="p-price"
            className="fx-input"
            inputMode="decimal"
            autoComplete="off"
            value={priceText}
            onChange={(e) => setPriceText(e.target.value)}
            aria-invalid={priceError ? true : undefined}
            aria-describedby={priceError ? 'p-price-err p-price-hint' : 'p-price-hint'}
            disabled={disabled}
            required
          />
          <p id="p-price-hint" className="fx-hint">
            {price.ok
              ? `Se cobrará ${formatAmount(price.minor, currency, 'es')} por unidad.`
              : 'Precio por unidad, en la moneda del producto.'}
          </p>
          {priceError ? (
            <p id="p-price-err" className="fx-error-text">
              {priceError}
            </p>
          ) : null}
        </div>
        <div className="fx-field">
          <label htmlFor="p-currency">Moneda</label>
          <select
            id="p-currency"
            className="fx-select"
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            disabled={disabled || editing || Boolean(base)}
            aria-describedby="p-currency-hint"
          >
            {[...new Set([defaultCurrency, ...POS_CURRENCIES])].map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <p id="p-currency-hint" className="fx-hint">
            {editing
              ? 'La moneda no se cambia tras crear el producto.'
              : 'Por defecto, la del comercio. Una venta usa una sola moneda.'}
          </p>
        </div>
      </div>

      <div className="fx-row">
        <div className="fx-field">
          <label htmlFor="p-sku">SKU (opcional)</label>
          <input
            id="p-sku"
            className="fx-input"
            value={sku}
            maxLength={64}
            onChange={(e) => setSku(e.target.value)}
            disabled={disabled}
          />
        </div>
        <div className="fx-field">
          <label htmlFor="p-cat">Categoría</label>
          <select
            id="p-cat"
            className="fx-select"
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            disabled={disabled}
          >
            <option value="">Sin categoría</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {canEdit ? (
        <div className="fx-field">
          <label htmlFor="p-newcat">Nueva categoría (opcional)</label>
          <div className="fx-row" style={{ alignItems: 'stretch' }}>
            <input
              id="p-newcat"
              className="fx-input"
              style={{ flex: '1 1 12rem' }}
              value={newCategory}
              maxLength={60}
              onChange={(e) => setNewCategory(e.target.value)}
              disabled={busy}
            />
            <button
              type="button"
              className="fx-btn"
              onClick={() => void addCategory()}
              disabled={busy || newCategory.trim() === ''}
            >
              Crear categoría
            </button>
          </div>
          <p className="fx-hint" aria-live="polite">
            {catMsg}
          </p>
        </div>
      ) : null}

      <div className="fx-field">
        <label htmlFor="p-desc">Descripción (opcional)</label>
        <textarea
          id="p-desc"
          className="fx-textarea"
          value={description}
          maxLength={500}
          onChange={(e) => setDescription(e.target.value)}
          disabled={disabled}
        />
      </div>

      {images.length > 0 ? (
        <fieldset className="fx-field" style={{ border: 0, padding: 0, margin: '0 0 16px' }}>
          <legend>Imagen</legend>
          <p className="fx-hint" style={{ marginBottom: 8 }}>
            Fotos de demostración con licencia CC0 (origen en Configuración → Imágenes).
          </p>
          <ul className="fx-gallery">
            <li>
              <label title="Sin imagen">
                <input
                  type="radio"
                  name="p-image"
                  checked={imageRef === null}
                  onChange={() => setImageRef(null)}
                  disabled={disabled}
                  aria-label="Sin imagen"
                />
                <ProductThumb
                  product={{ name: name || '·', image_ref: null, category_name: null }}
                />
              </label>
            </li>
            {images.map((img) => (
              <li key={img.ref}>
                <label title={`${img.label} — ${img.creator} (${img.license})`}>
                  <input
                    type="radio"
                    name="p-image"
                    checked={imageRef === img.ref}
                    onChange={() => setImageRef(img.ref)}
                    disabled={disabled}
                    aria-label={img.label}
                  />
                  <ProductThumb
                    product={{ name: img.label, image_ref: img.ref, category_name: null }}
                  />
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      ) : null}

      <div className="fx-field">
        <label className="fx-check" htmlFor="p-available">
          <input
            id="p-available"
            type="checkbox"
            checked={available}
            onChange={(e) => setAvailable(e.target.checked)}
            disabled={disabled}
          />
          <span>
            Disponible para vender
            <span className="fx-hint" style={{ display: 'block' }}>
              Si lo desmarcas, no aparece en «Nueva venta» aunque haya existencias.
            </span>
          </span>
        </label>
      </div>

      <div className="fx-field">
        <label className="fx-check" htmlFor="p-track">
          <input
            id="p-track"
            type="checkbox"
            checked={trackStock}
            onChange={(e) => setTrackStock(e.target.checked)}
            disabled={disabled}
          />
          <span>
            Controlar existencias
            <span className="fx-hint" style={{ display: 'block' }}>
              Cada venta reserva unidades; se descuentan solo cuando el cobro se confirma y se
              liberan si la venta se anula. Registra las entradas en la ficha del producto.
            </span>
          </span>
        </label>
      </div>

      {canEdit ? (
        <div className="fx-actions">
          <button type="submit" className="fx-btn fx-btn-primary" disabled={busy}>
            {busy ? 'Guardando…' : editing ? 'Guardar cambios' : 'Crear producto'}
          </button>
          {editing && current ? (
            <button
              type="button"
              className={current.archived ? 'fx-btn' : 'fx-btn fx-btn-danger'}
              onClick={() => void submit({ archived: !current.archived })}
              disabled={busy}
            >
              {current.archived ? 'Restaurar producto' : 'Archivar producto'}
            </button>
          ) : null}
          <a className="fx-btn" href={`/o/${orgId}/catalog`}>
            Volver al catálogo
          </a>
        </div>
      ) : null}
    </form>
  );
}
