/**
 * Tipos de los helpers PUROS de scripts/verify-runtime-image.mjs (el
 * verificador dinamico de la imagen runtime no tiene build TS propio; los
 * tests importan sus helpers directamente).
 */
declare module '*verify-runtime-image.mjs' {
  export interface TarEntry {
    type: 'file' | 'dir' | 'symlink' | 'hardlink' | 'special';
    path: string;
    linkTarget: string | null;
    size: number;
    sha256?: string;
    content?: Buffer;
  }
  export interface TarScanOptions {
    seedHashes?: Map<string, string>;
    caSha256?: string | null;
    caNeedle?: string | null;
  }
  export class TarFormatError extends Error {}
  export const FORBIDDEN_SCRIPTS: string[];
  export const SEMANTIC_MARKERS: string[];
  export const SEMANTIC_PAIRS: Array<[string, string]>;
  export function normalizeTarPath(path: string): string;
  export function parseTarEntries(
    buf: Buffer,
    capture?: (path: string, size: number) => boolean
  ): TarEntry[];
  export function isForbiddenImagePath(path: string): boolean;
  export function isForbiddenLinkTarget(target: string | null | undefined): boolean;
  export function isSemanticScanPath(path: string): boolean;
  export function semanticSignatureViolation(text: string): string[];
  export function manifestKindForPath(path: string): 'workspace' | 'dependency' | 'nested' | null;
  export function packageJsonViolations(rawText: string, path: string): string[];
  export function redactForLog(text: string): string;
  export function shouldCaptureContent(path: string): boolean;
  export function scanTarEntries(
    entries: TarEntry[],
    label: string,
    options?: TarScanOptions
  ): string[];
  export function createTarScanner(
    label: string,
    options?: TarScanOptions
  ): {
    onEntry: (entry: TarEntry) => void;
    violations: string[];
    paths: Set<string>;
    entryCount: () => number;
  };
}
