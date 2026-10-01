import type { ReactNode } from 'react';
import { formatAmount } from './money-format';
import type { CommerceInsights, Product } from './commerce-api';

/**
 * Piezas visuales del comercio (server-safe, sin estado): miniatura de
 * producto, existencias, selector segmentado, barras diarias y ranking.
 * Ver docs/design/fluvia-visual-direction.md.
 */

const PH_TONES = ['#dff0ec', '#f3e7d1', '#e8e3f5', '#e5f3ea', '#fbe7dd', '#e3edf5'];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * Foto del conjunto de demostración (servida por la propia app: CSP
 * `img-src 'self'`) o un marcador con la inicial y el tono de su categoría.
 * Decorativa: el nombre del producto siempre está en texto al lado.
 */
export function ProductThumb({
  product,
  size,
}: {
  product: Pick<Product, 'name' | 'image_ref' | 'category_name'>;
  size?: 'md' | 'lg';
}) {
  const cls = `fx-thumb${size ? ` fx-thumb-${size}` : ''}`;
  if (product.image_ref && /^catalog\/[a-z0-9-]{1,48}\.jpg$/.test(product.image_ref)) {
    return (
      <span className={cls}>
        <img src={`/${product.image_ref}`} alt="" loading="lazy" width={480} height={480} />
      </span>
    );
  }
  const tone = PH_TONES[hash(product.category_name ?? product.name) % PH_TONES.length];
  return (
    <span className={cls} data-ph="" style={{ ['--ph' as string]: tone }} aria-hidden="true">
      {(product.name.trim()[0] ?? '·').toUpperCase()}
    </span>
  );
}

export const LOW_STOCK = 3;

export function stockLevel(p: Pick<Product, 'track_stock' | 'stock'>) {
  if (!p.track_stock || !p.stock) return 'untracked' as const;
  if (p.stock.free <= 0) return 'out' as const;
  if (p.stock.free <= LOW_STOCK) return 'low' as const;
  return 'ok' as const;
}

export function StockBadge({
  product,
  showUntracked = false,
}: {
  product: Pick<Product, 'track_stock' | 'stock'>;
  showUntracked?: boolean;
}) {
  const level = stockLevel(product);
  if (level === 'untracked') {
    return showUntracked ? (
      <span className="fx-stock" data-level="untracked">
        Sin control de existencias
      </span>
    ) : null;
  }
  const free = product.stock!.free;
  const text =
    level === 'out' ? 'Agotado' : level === 'low' ? `Quedan ${free}` : `${free} disponibles`;
  return (
    <span className="fx-stock" data-level={level}>
      {text}
    </span>
  );
}

/** Selector segmentado de enlaces (periodo, moneda): funciona sin JS. */
export function Segmented({
  label,
  items,
}: {
  label: string;
  items: Array<{ href: string; label: ReactNode; current: boolean; title?: string }>;
}) {
  return (
    <nav aria-label={label} className="fx-seg">
      {items.map((i) => (
        <a key={i.href} href={i.href} aria-current={i.current ? 'true' : undefined} title={i.title}>
          {i.label}
        </a>
      ))}
    </nav>
  );
}

/**
 * Barras diarias: registrado (sol) y cobrado (río) por día UTC. SVG
 * decorativo + tabla accesible equivalente (sr-only). Sin coma flotante en
 * los importes mostrados: las alturas sí son proporciones (solo dibujo).
 */
export function DayBars({
  series,
  currency,
}: {
  series: CommerceInsights['series'];
  currency: string;
}) {
  const W = 640;
  const H = 150;
  const pad = { top: 8, bottom: 22, left: 4, right: 4 };
  const max = Math.max(1, ...series.map((d) => Math.max(d.orders_amount, d.confirmed_amount)));
  const n = series.length;
  const slot = (W - pad.left - pad.right) / Math.max(n, 1);
  const bw = Math.max(2, Math.min(18, slot / 2.6));
  const h = (v: number) => ((H - pad.top - pad.bottom) * v) / max;
  const every = Math.ceil(n / 8);
  const label = (day: string) => {
    const [, m, d] = day.split('-');
    return `${Number(d)}/${Number(m)}`;
  };
  return (
    <figure style={{ margin: 0 }}>
      <svg className="fx-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-hidden="true">
        <line className="axis" x1={0} x2={W} y1={H - pad.bottom} y2={H - pad.bottom} />
        {series.map((d, i) => {
          const x = pad.left + i * slot + slot / 2;
          const ho = h(d.orders_amount);
          const hc = h(d.confirmed_amount);
          return (
            <g key={d.day}>
              <rect
                className="bar-o"
                x={x - bw - 1}
                y={H - pad.bottom - ho}
                width={bw}
                height={ho}
                rx={2}
              />
              <rect
                className="bar-c"
                x={x + 1}
                y={H - pad.bottom - hc}
                width={bw}
                height={hc}
                rx={2}
              />
              {i % every === 0 || i === n - 1 ? (
                <text x={x} y={H - 6} textAnchor="middle">
                  {label(d.day)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <figcaption className="sr-only">
        <table>
          <caption>Ventas registradas y cobradas por día (UTC)</caption>
          <thead>
            <tr>
              <th scope="col">Día</th>
              <th scope="col">Registrado</th>
              <th scope="col">Cobrado</th>
            </tr>
          </thead>
          <tbody>
            {series.map((d) => (
              <tr key={d.day}>
                <th scope="row">{d.day}</th>
                <td>{formatAmount(d.orders_amount, currency, 'es')}</td>
                <td>{formatAmount(d.confirmed_amount, currency, 'es')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </figcaption>
    </figure>
  );
}
