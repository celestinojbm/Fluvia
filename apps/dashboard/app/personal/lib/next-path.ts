/**
 * Destino tras «Entrar»: solo rutas INTERNAS de Personal (nunca otro host,
 * `//`, esquemas ni la propia pantalla de entrada). Cualquier otra cosa ⇒ Inicio.
 */
export function safePersonalNext(raw: string | null | undefined): string {
  if (!raw || raw.length > 300) return '/personal';
  if (!/^\/personal(?:[/?][A-Za-z0-9/_\-?=&%.~]*)?$/.test(raw)) return '/personal';
  if (raw.includes('//') || raw.includes('\\') || raw.startsWith('/personal/entrar')) {
    return '/personal';
  }
  return raw;
}
