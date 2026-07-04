import { describe, expect, it } from 'vitest';
import {
  InvalidWebhookSignatureError,
  signWebhookPayload,
  verifyWebhookSignature,
} from '../src/index.js';

// Fixture de test, NO es un secreto real (falso positivo de gitleaks en CI).
const SECRET = 'whsec_test_fixture_not_a_real_secret'; // gitleaks:allow
const BODY = '{"id":"evt_1","type":"payment.captured","amount":1000}';

describe('firma de webhooks entrantes (F2-12, V4 §28)', () => {
  it('accepts a fresh, correctly signed payload', () => {
    const ts = 1_751_000_000_000;
    const sig = signWebhookPayload(SECRET, ts, BODY);
    expect(() =>
      verifyWebhookSignature({
        secret: SECRET,
        rawBody: BODY,
        timestampMs: ts,
        signature: sig,
        nowMs: ts + 1000,
      })
    ).not.toThrow();
  });

  it('rejects a wrong secret, a tampered body and a tampered timestamp', () => {
    const ts = 1_751_000_000_000;
    const sig = signWebhookPayload(SECRET, ts, BODY);
    expect(() =>
      verifyWebhookSignature({
        secret: 'whsec_other',
        rawBody: BODY,
        timestampMs: ts,
        signature: sig,
        nowMs: ts,
      })
    ).toThrow(InvalidWebhookSignatureError);
    expect(() =>
      verifyWebhookSignature({
        secret: SECRET,
        rawBody: BODY.replace('1000', '9999'),
        timestampMs: ts,
        signature: sig,
        nowMs: ts,
      })
    ).toThrow(InvalidWebhookSignatureError);
    // Reusar la firma con otro timestamp (dentro de tolerancia) tampoco pasa:
    // el timestamp esta FIRMADO.
    expect(() =>
      verifyWebhookSignature({
        secret: SECRET,
        rawBody: BODY,
        timestampMs: ts + 60_000,
        signature: sig,
        nowMs: ts + 60_000,
      })
    ).toThrow(InvalidWebhookSignatureError);
  });

  it('rejects stale or future timestamps beyond the tolerance window', () => {
    const ts = 1_751_000_000_000;
    const sig = signWebhookPayload(SECRET, ts, BODY);
    const sixMinutes = 6 * 60 * 1000;
    expect(() =>
      verifyWebhookSignature({
        secret: SECRET,
        rawBody: BODY,
        timestampMs: ts,
        signature: sig,
        nowMs: ts + sixMinutes,
      })
    ).toThrow(/tolerance/);
    expect(() =>
      verifyWebhookSignature({
        secret: SECRET,
        rawBody: BODY,
        timestampMs: ts + sixMinutes,
        signature: sig,
        nowMs: ts,
      })
    ).toThrow(/tolerance/);
    // Tolerancia configurable
    expect(() =>
      verifyWebhookSignature({
        secret: SECRET,
        rawBody: BODY,
        timestampMs: ts,
        signature: sig,
        nowMs: ts + sixMinutes,
        toleranceMs: 10 * 60 * 1000,
      })
    ).not.toThrow();
  });

  it('rejects malformed signatures and timestamps without throwing internal errors', () => {
    const ts = 1_751_000_000_000;
    expect(() =>
      verifyWebhookSignature({
        secret: SECRET,
        rawBody: BODY,
        timestampMs: ts,
        signature: 'short',
        nowMs: ts,
      })
    ).toThrow(InvalidWebhookSignatureError);
    expect(() =>
      verifyWebhookSignature({
        secret: SECRET,
        rawBody: BODY,
        timestampMs: Number.NaN,
        signature: 'x',
        nowMs: ts,
      })
    ).toThrow(/timestamp/);
  });
});
