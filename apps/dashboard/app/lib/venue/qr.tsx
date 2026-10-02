import qrcode from 'qrcode-generator';

/**
 * Código QR como SVG (sin red, sin canvas). Negro sobre blanco con zona de
 * silencio: lo leen las cámaras aunque la pantalla esté sobre menta. El texto
 * del enlace se muestra aparte (el QR nunca es la única vía).
 */
export function QrCode({
  value,
  label,
  size = 200,
}: {
  value: string;
  label: string;
  size?: number;
}) {
  const qr = qrcode(0, 'M');
  qr.addData(value);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 4;
  const total = n + quiet * 2;
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }
  }
  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${total} ${total}`}
      shapeRendering="crispEdges"
      style={{ background: '#fff', display: 'block' }}
    >
      <rect width={total} height={total} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}
