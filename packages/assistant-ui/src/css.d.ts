declare module '*.css';
// Next inyecta en build las variables NEXT_PUBLIC_* (ganchos E2E).
declare const process: { env: Record<string, string | undefined> };
