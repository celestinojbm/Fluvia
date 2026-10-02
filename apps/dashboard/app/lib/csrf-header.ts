/**
 * RA-F65B-EXT-002 — header anti-CSRF no-simple que las llamadas MUTANTES
 * legítimas del dashboard añaden a su fetch. Fuente única en
 * `@fluvia/assistant-ui` (lo usa también el checkout); la política completa
 * vive en `csrf.ts` (server-side).
 */
export { CSRF_HEADER, CSRF_HEADER_VALUE } from '@fluvia/assistant-ui/csrf-header';
