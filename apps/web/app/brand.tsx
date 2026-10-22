/**
 * Identidad Fluvia «Menta» (docs/design/identidad-menta.md): símbolo
 * «meandro» (el río entre dos orillas) y logotipo de letras construidas.
 * Geometría idéntica a docs/design/brand/svg/*.svg. Decorativos por defecto:
 * el nombre «Fluvia» lo da el texto o la etiqueta del enlace que los contiene.
 */
const WORD = [
  'M8 100V46a18 18 0 0 1 18-18h14v13H26a5 5 0 0 0-5 5v54z',
  'M0 50h34v12H0z',
  'M50 28h13v72H50z',
  'M74 50h13v28a9 9 0 0 0 18 0V50h13v28a22 22 0 0 1-44 0z',
  'M105 50h13v50h-13z',
  'M128 50h14l8 22.2 8-22.2h14l-18 50h-8z',
  'M182 50h13v50h-13z',
  'M182 28h13v13h-13z',
  'M242 50h13v50h-13z',
];
const BOWL = 'M230 50a25 25 0 1 0 0 50a25 25 0 1 0 0-50zm0 13a12 12 0 1 1 0 24a12 12 0 1 1 0-24z';

export type BrandTone = 'black' | 'mint' | 'white';
const TILE: Record<BrandTone, [string, string]> = {
  black: ['var(--fl-black)', 'var(--fl-mint)'],
  mint: ['var(--fl-mint)', 'var(--fl-black)'],
  white: ['var(--fl-white)', 'var(--fl-black)'],
};

export function FluviaSymbol({ size = 28, tone = 'black' }: { size?: number; tone?: BrandTone }) {
  const [tile, band] = TILE[tone];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      aria-hidden="true"
      focusable="false"
      className="fl-symbol"
    >
      <rect width="48" height="48" rx="12" fill={tile} />
      <path d="M0 17h14c10 0 10 14 20 14h14" fill="none" stroke={band} strokeWidth="8" />
    </svg>
  );
}

export function FluviaWordmark({
  height = 20,
  color = 'currentColor',
}: {
  height?: number;
  color?: string;
}) {
  return (
    <svg
      height={height}
      width={(height * 255) / 72}
      viewBox="0 28 255 72"
      aria-hidden="true"
      focusable="false"
      className="fl-wordmark"
    >
      <g fill={color}>
        {WORD.map((d) => (
          <path key={d} d={d} />
        ))}
        <path d={BOWL} fillRule="evenodd" />
      </g>
    </svg>
  );
}

/** Firma: símbolo + logotipo; el símbolo mide lo mismo que ascendente→base. */
export function FluviaLogo({
  height = 24,
  tone = 'black',
  label,
}: {
  height?: number;
  tone?: 'black' | 'white';
  /** Nombre de la superficie («Personal», «Operaciones»), opcional. */
  label?: string;
}) {
  return (
    <span className="fl-logo" data-tone={tone} style={{ gap: Math.round(height * 0.4) }}>
      <FluviaSymbol size={height} tone={tone === 'black' ? 'black' : 'mint'} />
      <FluviaWordmark
        height={height}
        color={tone === 'black' ? 'var(--fl-black)' : 'var(--fl-white)'}
      />
      {label ? <span className="fl-logo-label">{label}</span> : null}
      <span className="sr-only">Fluvia{label ? ` ${label}` : ''}</span>
    </span>
  );
}
