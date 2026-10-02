import { apiBase } from './api';

/**
 * Lecturas PÚBLICAS de la presentación (sin sesión), siempre server-side: el
 * navegador no conoce la URL de la API. Cada lectura distingue «ok», «no
 * existe» y «error» para que la página muestre un estado honesto en lugar de
 * un vacío engañoso.
 */
export type PublicRead<T> = { kind: 'ok'; data: T } | { kind: 'not_found' } | { kind: 'error' };

async function read<T>(path: string): Promise<PublicRead<T>> {
  try {
    const res = await fetch(`${apiBase()}${path}`, { cache: 'no-store' });
    if (res.status === 404) return { kind: 'not_found' };
    if (!res.ok) return { kind: 'error' };
    return { kind: 'ok', data: (await res.json()) as T };
  } catch {
    return { kind: 'error' };
  }
}

export const CATEGORY_SLUGS = [
  'alimentacion',
  'restaurantes',
  'moda',
  'hogar',
  'tecnologia',
  'salud',
  'papeleria',
  'servicios',
] as const;
export type CategorySlug = (typeof CATEGORY_SLUGS)[number];

export interface DirectoryEntry {
  slug: string;
  display_name: string;
  category: CategorySlug;
  city: string;
  area: string | null;
  summary: string | null;
  channels: Array<'in_store' | 'online'>;
  photo_ref: string | null;
  is_demo: boolean;
  published_at: string;
}

export function searchDirectory(opts: {
  q?: string;
  category?: CategorySlug;
  city?: string;
  offset?: number;
}): Promise<PublicRead<{ data: DirectoryEntry[]; has_more: boolean }>> {
  const qs = new URLSearchParams();
  if (opts.q) qs.set('q', opts.q);
  if (opts.category) qs.set('category', opts.category);
  if (opts.city) qs.set('city', opts.city);
  if (opts.offset) qs.set('offset', String(opts.offset));
  qs.set('limit', '24');
  return read(`/v1/public/directory?${qs.toString()}`);
}

export function directoryEntry(slug: string): Promise<PublicRead<DirectoryEntry>> {
  return read(`/v1/public/directory/${encodeURIComponent(slug)}`);
}

export function directoryCities(): Promise<PublicRead<{ data: string[] }>> {
  return read('/v1/public/directory/cities');
}

export interface ProgramTerms {
  name: string;
  sandbox: boolean;
  currencies: string[];
  policy: {
    code: string;
    version: number;
    synthetic: boolean;
    pending_commercial_validation: boolean;
    installment_counts: number[];
    interval_days: number;
    down_payment_bps: number;
    interest_bps: number;
    late_fee_bps: number;
    grace_days: number;
    max_multiplier_bps: number;
    authorization_ttl_hours: number;
    limits: Record<string, { min_collateral: number; max_limit: number }>;
  };
  cards: { max_live: number };
}

/** Condiciones de la política ACTIVA del programa configurado en este despliegue. */
export function programTerms(): Promise<PublicRead<ProgramTerms>> {
  const id = process.env.FLUVIA_PROGRAM_TENANT_ID ?? '';
  if (!/^[0-9a-f-]{36}$/i.test(id)) return Promise.resolve({ kind: 'not_found' });
  return read(`/v1/public/programs/${id}/terms`);
}
