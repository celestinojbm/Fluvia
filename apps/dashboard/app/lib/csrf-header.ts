/**
 * RA-F65B-EXT-002 — header anti-CSRF no-simple que las llamadas MUTANTES
 * legítimas del dashboard añaden a su fetch. Módulo aislado (sin next/server)
 * para que los componentes de cliente lo importen sin arrastrar código de
 * servidor; la política completa vive en `csrf.ts` (server-side).
 */
export const CSRF_HEADER = 'x-fluvia-csrf';
export const CSRF_HEADER_VALUE = '1';
