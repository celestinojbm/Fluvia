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
    needleHit?: boolean;
  }
  export interface LexicalInventoryEntry {
    path: string;
    fingerprint: string;
    literals: Set<string>;
    shingles: Set<number>;
  }
  export interface LexicalInventory {
    entries: LexicalInventoryEntry[];
    screenNeedles: string[];
  }
  export interface TarScanOptions {
    seedHashes?: Map<string, string>;
    caSha256?: string | null;
    lexicalInventory?: LexicalInventory | null;
  }
  export class TarFormatError extends Error {}
  export const FORBIDDEN_SCRIPTS: string[];
  export const SEMANTIC_MARKERS: string[];
  export const SEMANTIC_PAIRS: Array<[string, string]>;
  export function normalizeTarPath(path: string): string;
  export function parseTarEntries(
    buf: Buffer,
    capture?: (path: string, size: number) => boolean,
    options?: { needle?: Buffer | null }
  ): TarEntry[];
  export function isForbiddenImagePath(path: string): boolean;
  export function isForbiddenLinkTarget(target: string | null | undefined): boolean;
  export function isSemanticScanPath(path: string): boolean;
  export function semanticSignatureViolation(text: string): string[];
  export function manifestKindForPath(path: string): 'workspace' | 'dependency' | 'nested' | null;
  export function packageJsonViolations(rawText: string, path: string): string[];
  export function dependencySpecResolvesFluviaSeeds(name: string, spec: unknown): boolean;
  export function workspacePatternCanResolveFluviaSeeds(pattern: unknown): boolean;
  export function canonicalTokens(source: string): string[];
  export function lexicalFingerprint(source: string): string;
  export function tokenShingles(tokens: string[], k?: number): Set<number>;
  export function extractStringLiterals(source: string): Set<string>;
  export function buildLexicalInventory(
    files: Array<{ path: string; text: string }>
  ): LexicalInventory;
  export function transformedCopyViolation(
    candidateText: string,
    lexicalInventory: LexicalInventory
  ): string | null;
  export function matchesLexicalScreen(text: string, lexicalInventory: LexicalInventory): boolean;
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
  export function runBoundedProcess(
    cmd: string,
    args: string[],
    opts?: { timeoutMs?: number; outputLimitBytes?: number; cwd?: string }
  ): Promise<{ stdout: string; stderr: string }>;
  export function createDockerCleanupTracker(
    exec: (args: string[], timeoutMs: number) => Promise<unknown>
  ): {
    register(kind: 'container' | 'image' | 'network' | 'volume', id: string, label?: string): void;
    removeNow(kind: string, id: string): Promise<boolean>;
    cleanupAll(): Promise<{
      ok: boolean;
      failures: Array<{ kind: string; label: string }>;
      summary: string[];
    }>;
  };
}
