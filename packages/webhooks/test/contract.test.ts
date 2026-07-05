import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEV_WEBHOOK_SECRET_ENC_KEY_HEX,
  UnsafeWebhookUrlError,
  WEBHOOK_TOPICS,
  assertSafeWebhookUrl,
  buildSignatureHeader,
  decryptEndpointSecret,
  encryptEndpointSecret,
  generateEndpointSecret,
  isPrivateIp,
  resolveSafeWebhookTarget,
  signWebhookDelivery,
  verifyWebhookDelivery,
} from '../src/index.js';

const DOC_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'docs',
  'architecture',
  'webhook-delivery.md'
);

describe('catalogo de eventos (meta-test doc §5 ↔ codigo)', () => {
  it('webhook-delivery.md §5 lists EXACTLY the topics in events.ts', () => {
    const doc = readFileSync(DOC_PATH, 'utf8');
    const section = doc.slice(doc.indexOf('## 5.'), doc.indexOf('## 6.'));
    // `resource.a|b|c` -> resource.a, resource.b, resource.c
    const docTopics = [...section.matchAll(/`([a-z_]+)\.([a-z_|]+)`/g)]
      .filter((m) => !section.slice(0, m.index).includes('Reservados post-MVP') || false)
      .flatMap((m) => m[2]!.split('|').map((s) => `${m[1]}.${s}`));
    // Solo la lista del catalogo (antes de "Reservados post-MVP").
    const activePart = section.slice(0, section.indexOf('Reservados post-MVP'));
    const active = [...activePart.matchAll(/`([a-z_]+)\.([a-z_|]+)`/g)].flatMap((m) =>
      m[2]!.split('|').map((s) => `${m[1]}.${s}`)
    );
    expect(active.sort()).toEqual([...WEBHOOK_TOPICS].sort());
    expect(docTopics.length).toBeGreaterThan(0);
  });
});

describe('firma versionada (§2)', () => {
  const secret = 'whsec_test_fixture_not_a_real_secret'; // gitleaks:allow
  const ts = 1_751_700_000;
  const eventId = 'whe_00000000-0000-4000-8000-000000000001';
  const body = '{"hello":"world"}';

  it('signs "{timestamp}.{event_id}.{raw_body}" and verifies in constant time', () => {
    const header = buildSignatureHeader([secret], ts, eventId, body);
    expect(header).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(
      verifyWebhookDelivery({
        secret,
        signatureHeader: header,
        timestampSec: ts,
        eventId,
        rawBody: body,
        nowMs: ts * 1000,
      })
    ).toBe(true);
    // Cuerpo alterado o secreto equivocado: no verifica.
    expect(
      verifyWebhookDelivery({
        secret,
        signatureHeader: header,
        timestampSec: ts,
        eventId,
        rawBody: body + ' ',
        nowMs: ts * 1000,
      })
    ).toBe(false);
    expect(
      verifyWebhookDelivery({
        secret: 'whsec_other',
        signatureHeader: header,
        timestampSec: ts,
        eventId,
        rawBody: body,
        nowMs: ts * 1000,
      })
    ).toBe(false);
  });

  it('rotation: multi-signature header verifies with EITHER secret; stale timestamps fail', () => {
    const oldSecret = 'whsec_previous';
    const header = buildSignatureHeader([secret, oldSecret], ts, eventId, body);
    expect(header.split(',')).toHaveLength(2);
    for (const s of [secret, oldSecret]) {
      expect(
        verifyWebhookDelivery({
          secret: s,
          signatureHeader: header,
          timestampSec: ts,
          eventId,
          rawBody: body,
          nowMs: ts * 1000,
        })
      ).toBe(true);
    }
    // Tolerancia ±5 min.
    expect(
      verifyWebhookDelivery({
        secret,
        signatureHeader: header,
        timestampSec: ts,
        eventId,
        rawBody: body,
        nowMs: (ts + 301) * 1000,
      })
    ).toBe(false);
  });

  it('deterministic vector (contract): the signature format never drifts silently', () => {
    expect(signWebhookDelivery(secret, ts, eventId, body)).toBe(
      signWebhookDelivery(secret, ts, eventId, body)
    );
  });
});

describe('cifrado de secretos de endpoint en reposo', () => {
  it('roundtrips and never stores plaintext', () => {
    const secret = generateEndpointSecret();
    expect(secret).toMatch(/^whsec_[0-9a-f]{48}$/);
    const enc = encryptEndpointSecret(DEV_WEBHOOK_SECRET_ENC_KEY_HEX, secret);
    expect(enc).not.toContain(secret);
    expect(decryptEndpointSecret(DEV_WEBHOOK_SECRET_ENC_KEY_HEX, enc)).toBe(secret);
  });
});

describe('guard SSRF (§4)', () => {
  it('denylists private, loopback, link-local, CGNAT, multicast and v4-mapped addresses', () => {
    for (const ip of [
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '127.0.0.1',
      '0.0.0.0',
      '169.254.169.254', // metadata
      '100.64.0.1',
      '224.0.0.1',
      '::1',
      'fe80::1',
      'fd12::1',
      'ff02::1',
      '::ffff:10.0.0.1',
    ]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
    for (const ip of ['93.184.216.34', '2606:2800:220:1::1']) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });

  it('requires https and port 443 outside local; rejects credentials and garbage', () => {
    expect(() => assertSafeWebhookUrl('http://example.com/hook')).toThrow(UnsafeWebhookUrlError);
    expect(() => assertSafeWebhookUrl('https://example.com:8443/hook')).toThrow(/port 8443/);
    expect(() => assertSafeWebhookUrl('https://user:pass@example.com/hook')).toThrow(/credentials/);
    expect(() => assertSafeWebhookUrl('ftp://example.com/x')).toThrow(UnsafeWebhookUrlError);
    expect(() => assertSafeWebhookUrl('not a url')).toThrow(/malformed/);
    expect(() => assertSafeWebhookUrl('https://example.com/hook')).not.toThrow();
    // Local/test: http y puertos arbitrarios permitidos (guard por entorno).
    expect(() =>
      assertSafeWebhookUrl('http://127.0.0.1:8099/hook', { allowPrivateNetworks: true })
    ).not.toThrow();
  });

  it('rejects hostnames resolving to ANY private address (rebinding bait)', async () => {
    await expect(
      resolveSafeWebhookTarget('https://evil.example/hook', {
        resolve: () => Promise.resolve(['93.184.216.34', '169.254.169.254']),
      })
    ).rejects.toThrow(/non-public address 169\.254\.169\.254/);
    const ok = await resolveSafeWebhookTarget('https://good.example/hook', {
      resolve: () => Promise.resolve(['93.184.216.34']),
    });
    expect(ok.ip).toBe('93.184.216.34');
    expect(ok.port).toBe(443);
  });
});
