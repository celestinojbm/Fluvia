/**
 * Cabecera anti-CSRF no-simple que las llamadas MUTANTES legítimas añaden a
 * su fetch (panel y checkout). Fuente única: el panel la reexporta.
 */
export const CSRF_HEADER = 'x-fluvia-csrf';
export const CSRF_HEADER_VALUE = '1';
