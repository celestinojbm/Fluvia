import type { Pool } from '@fluvia/db';
import { verifyWebhookSignature } from './signature.js';

/**
 * Ingesta durable de webhooks entrantes (F2-12, V4 §28).
 *
 * Contrato (espejo de outbox-inbox.md §3):
 *  1. Limite de tamano sobre el raw body.
 *  2. Verificacion de firma + frescura ANTES de persistir (un emisor no
 *     autenticado no llena la base).
 *  3. INSERT ... ON CONFLICT DO NOTHING sobre (provider, provider_event_id):
 *     el duplicado es detectable sin SELECT y es race-safe — N entregas
 *     concurrentes del mismo evento persisten exactamente 1 fila.
 *  4. El caller HTTP responde exito SOLO despues de que ingest() resuelve
 *     (la fila ya esta durable; el procesamiento es asincrono).
 */

export class PayloadTooLargeError extends Error {
  constructor(
    readonly bytes: number,
    readonly maxBytes: number
  ) {
    super(`Webhook payload of ${bytes} bytes exceeds the ${maxBytes}-byte limit`);
    this.name = 'PayloadTooLargeError';
  }
}

/** Headers que se persisten como contexto; todo lo demas se descarta. */
export const DEFAULT_HEADER_ALLOWLIST = [
  'content-type',
  'user-agent',
  'x-request-id',
  'x-fluvia-timestamp',
  'x-fluvia-signature',
] as const;

export interface IngestSignature {
  secret: string;
  timestampMs: number;
  signature: string;
  toleranceMs?: number;
  nowMs?: number;
}

export interface IngestInput {
  provider: string;
  providerEventId: string;
  eventType?: string;
  rawBody: string;
  headers?: Record<string, string>;
  signature: IngestSignature;
}

export interface IngestResult {
  /** true si el evento ya existia: no se re-persiste ni se reprocesa. */
  duplicate: boolean;
  /** id interno de la fila nueva; null en duplicados (el buzon no es legible por la API). */
  id: string | null;
}

export interface InboxIngestOptions {
  maxBodyBytes?: number;
  headerAllowlist?: readonly string[];
}

export class InboxIngestService {
  private readonly maxBodyBytes: number;
  private readonly allowlist: Set<string>;

  constructor(
    /** Pool con rol fluvia_app: SOLO INSERT sobre provider_events. */
    private readonly appPool: Pool,
    options: InboxIngestOptions = {}
  ) {
    this.maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
    this.allowlist = new Set(
      (options.headerAllowlist ?? DEFAULT_HEADER_ALLOWLIST).map((h) => h.toLowerCase())
    );
  }

  async ingest(input: IngestInput): Promise<IngestResult> {
    const bytes = Buffer.byteLength(input.rawBody, 'utf8');
    if (bytes > this.maxBodyBytes) {
      throw new PayloadTooLargeError(bytes, this.maxBodyBytes);
    }
    // Firma invalida => excepcion y CERO persistencia.
    verifyWebhookSignature({
      secret: input.signature.secret,
      rawBody: input.rawBody,
      timestampMs: input.signature.timestampMs,
      signature: input.signature.signature,
      toleranceMs: input.signature.toleranceMs,
      nowMs: input.signature.nowMs,
    });

    const headers = Object.fromEntries(
      Object.entries(input.headers ?? {})
        .map(([k, v]) => [k.toLowerCase(), v] as const)
        .filter(([k]) => this.allowlist.has(k))
    );

    const res = await this.appPool.query<{ id: string }>(
      `INSERT INTO provider_events
         (provider, provider_event_id, event_type, raw_body, headers, signature_verified)
       VALUES ($1, $2, $3, $4, $5, true)
       ON CONFLICT (provider, provider_event_id) DO NOTHING
       RETURNING id::text AS id`,
      [
        input.provider,
        input.providerEventId,
        input.eventType ?? null,
        input.rawBody,
        JSON.stringify(headers),
      ]
    );
    if ((res.rowCount ?? 0) === 0) {
      return { duplicate: true, id: null };
    }
    return { duplicate: false, id: res.rows[0]!.id };
  }
}
