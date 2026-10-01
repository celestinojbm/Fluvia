'use client';

import { useMemo, useRef, useState } from 'react';
import { displayExponent, formatAmount } from '../messages';
import { clientCall, errorMessage } from './client-call';
import type { Category, Product } from './commerce-api';
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
}: {
  orgId: string;
  categories: Category[];
  product?: Product;
  defaultCurrency: string;
  canEdit: boolean;
}) {
  const editing = product !== undefined;
  const [name, setName] = useState(product?.name ?? '');
  const [sku, setSku] = useState(product?.sku ?? '');
  const [description, setDescription] = useState(product?.description ?? '');
  const [categoryId, setCategoryId] = useState(product?.category_id ?? '');
  const [currency, setCurrency] = useState(product?.currency ?? defaultCurrency);
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
    if (!extra && (name.trim() === '' || !price.ok)) return;
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
            disabled={disabled || editing}
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
              Disponibilidad declarada por el comercio. No hay control de existencias en esta
              versión.
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
