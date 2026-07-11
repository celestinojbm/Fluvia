/**
 * Badge global obligatorio de F6.5 (decisión #31): el checkout alojado opera
 * sobre dinero SIMULADO y debe decirlo sin ambigüedad en toda página. El texto
 * es literal (no se traduce): es la marca de entorno, no copy de producto.
 */
export const SANDBOX_BADGE_TEXT = 'SANDBOX — dinero simulado';

export function SandboxBadge() {
  return <p className="sandbox-badge">{SANDBOX_BADGE_TEXT}</p>;
}
