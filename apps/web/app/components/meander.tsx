/** Banda del símbolo (el mismo trazo del meandro), como divisor. No es el logo. */
const PATH = 'M-40 30H420C520 30 520 60 680 60H1280';

export function Meander({ tone = 'black' }: { tone?: 'black' | 'mint' }) {
  const stroke = tone === 'mint' ? 'var(--fl-mint)' : 'var(--fl-black)';
  return (
    <svg
      className={`meander meander-${tone}`}
      viewBox="0 0 1200 90"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATH} fill="none" stroke={stroke} strokeLinecap="butt" />
    </svg>
  );
}
