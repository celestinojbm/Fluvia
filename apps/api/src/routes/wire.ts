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
        .map(([k, v]) => [
          // Códigos ISO de moneda (VES, USD…) son claves de datos: no se tocan.
          /^[A-Z]{3}$/.test(k) ? k : k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`),
          snake(v),
        ])
    );
  }
  return value;
}

/** Inverso de `snake` para cuerpos que vuelven al dominio (p. ej. parámetros de política). */
export function camel(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camel);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        /^[A-Z]{3}$/.test(k) ? k : k.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase()),
        camel(v),
      ])
    );
  }
  return value;
}
