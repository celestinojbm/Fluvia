import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Firma de webhooks salientes (webhook-delivery.md §2, contrato
 * compatible-Svix por conceptos):
 *
 *   HMAC-SHA256 sobre "{timestamp}.{event_id}.{raw_body}"   (timestamp en
 *   segundos unix). Header `Fluvia-Signature: v1=<hex>[,v1=<hex>]` — durante
 *   la rotacion se firma con el secreto activo Y el anterior, para que el
 *   comercio pueda migrar sin perder entregas.
 */

export function signWebhookDelivery(
  secret: string,
  timestampSec: number,
  eventId: string,
  rawBody: string
): string {
  return createHmac('sha256', secret).update(`${timestampSec}.${eventId}.${rawBody}`).digest('hex');
}

export function buildSignatureHeader(
  secrets: readonly string[],
  timestampSec: number,
  eventId: string,
  rawBody: string
): string {
  return secrets
    .map((s) => `v1=${signWebhookDelivery(s, timestampSec, eventId, rawBody)}`)
    .join(',');
}

export interface VerifyDeliveryInput {
  secret: string;
  signatureHeader: string;
  timestampSec: number;
  eventId: string;
  rawBody: string;
  /** Tolerancia recomendada al receptor (default ±5 min). */
  toleranceMs?: number;
  nowMs?: number;
}

/**
 * Verificacion de referencia para comercios (los ejemplos del doc y el SDK
 * F3-10 usan EXACTAMENTE esto). Comparacion en tiempo constante.
 */
export function verifyWebhookDelivery(input: VerifyDeliveryInput): boolean {
  const tolerance = input.toleranceMs ?? 5 * 60 * 1000;
  const now = input.nowMs ?? Date.now();
  if (Math.abs(now - input.timestampSec * 1000) > tolerance) return false;
  const expected = signWebhookDelivery(
    input.secret,
    input.timestampSec,
    input.eventId,
    input.rawBody
  );
  return input.signatureHeader.split(',').some((part) => {
    const value = part.trim().replace(/^v1=/, '');
    if (value.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(value, 'hex'), Buffer.from(expected, 'hex'));
  });
}
