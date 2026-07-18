/**
 * Tipos de los helpers PUROS de scripts/verify-runtime-image.mjs (el
 * verificador dinamico de la imagen runtime no tiene build TS propio; los
 * tests importan sus helpers directamente).
 */
declare module '*verify-runtime-image.mjs' {
  export interface TarEntry {
    type: string;
    path: string;
    linkTarget: string | null;
  }
  export const FORBIDDEN_SCRIPTS: string[];
  export function normalizeTarPath(path: string): string;
  export function isForbiddenImagePath(path: string): boolean;
  export function isForbiddenLinkTarget(target: string | null | undefined): boolean;
  export function parseTarListing(listing: string): TarEntry[];
  export function isWorkspaceManifestPath(path: string): boolean;
  export function forbiddenScriptsIn(pkgJsonText: string): string[];
  export function scanEntries(entries: TarEntry[], label: string): string[];
}
