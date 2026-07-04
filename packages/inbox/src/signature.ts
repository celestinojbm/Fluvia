import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Firma de webhooks entrantes (F2-12, V4 §28).
 *
 * Esquema propio (lo usara el MockProvider en F3-03; contrato compatible en
 * espiritu con Svix/Stripe): HMAC-SHA256 hex sobre `${timestampMs}.${rawBody}`.
 * El timestamp firmado ata la firma al momento de emision (anti-replay junto
 * con la tolerancia y el dedup por provider_event_id).
 */

export class InvalidWebhookSignatureError extends Error {
  constructor(readonly detail: string) {
    // El detalle es para logs internos; el endpoint HTTP jamas lo expone.
    super(`Invalid webhook signature: ${detail}`);
    this.name = 'InvalidWebhookSignatureError';
  }
}

export const DEFAULT_SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;

export function signWebhookPayload(secret: string, timestampMs: number, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestampMs}.${rawBody}`).digest('hex');
}

export interface VerifyWebhookSignatureInput {
  secret: string;
  rawBody: string;
  /** Timestamp firmado que declara el emisor (epoch ms). */
  timestampMs: number;
  /** Firma hex recibida. */
  signature: string;
  toleranceMs?: number;
  /** Inyectable para tests deterministas; default Date.now(). */
  nowMs?: number;
}

/** Lanza InvalidWebhookSignatureError; si retorna, la firma es valida y fresca. */
export function verifyWebhookSignature(input: VerifyWebhookSignatureInput): void {
  const tolerance = input.toleranceMs ?? DEFAULT_SIGNATURE_TOLERANCE_MS;
  const now = input.nowMs ?? Date.now();
  if (!Number.isFinite(input.timestampMs)) {
    throw new InvalidWebhookSignatureError('missing or malformed timestamp');
  }
  if (Math.abs(now - input.timestampMs) > tolerance) {
    throw new InvalidWebhookSignatureError('timestamp outside tolerance window');
  }
  const expected = signWebhookPayload(input.secret, input.timestampMs, input.rawBody);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(input.signature ?? '', 'utf8');
  // timingSafeEqual exige buffers de igual longitud; una longitud distinta ya
  // es invalida y no filtra informacion util (la longitud esperada es publica).
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new InvalidWebhookSignatureError('signature mismatch');
  }
}
