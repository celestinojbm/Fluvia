/**
 * Serialización pública de las rutas del programa: claves en snake_case (como
 * el resto del API), bigint → string decimal (unidades menores, sin coma
 * flotante) y fechas ISO. Las cadenas no se tocan.
 */
export function snake(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(snake);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`), snake(v)])
    );
  }
  return value;
}
