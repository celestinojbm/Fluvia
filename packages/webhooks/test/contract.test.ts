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
  sanitizeUrlForDisplay,
  signWebhookDelivery,
  verifyWebhookDelivery,
  webhookUrlAuditMetadata,
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

  it('SECURITY (F6): a malformed same-length signature returns false, never throws', () => {
    const expected = signWebhookDelivery(secret, ts, eventId, body); // 64 hex
    // Misma longitud de string (64) pero con caracteres NO-hex: antes
    // Buffer.from(...,'hex') truncaba y timingSafeEqual lanzaba RangeError.
    const malformed = 'z'.repeat(expected.length);
    const verify = () =>
      verifyWebhookDelivery({
        secret,
        signatureHeader: `v1=${malformed}`,
        timestampSec: ts,
        eventId,
        rawBody: body,
        nowMs: ts * 1000,
      });
    expect(verify).not.toThrow();
    expect(verify()).toBe(false);
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

  it('SECURITY (F6): denylists NON-CANONICAL IPv6 literals that string-matching missed', () => {
    for (const ip of [
      '0:0:0:0:0:0:0:1', // ::1 sin comprimir (loopback)
      '0000:0000:0000:0000:0000:0000:0000:0001', // ::1 totalmente expandido
      '::ffff:7f00:1', // v4-mapped 127.0.0.1 en hextets
      '::ffff:0a00:0001', // v4-mapped 10.0.0.1 en hextets
      '::ffff:169.254.169.254', // v4-mapped metadata (dotted)
      'fe90::1', // resto de fe80::/10 (link-local), no solo fe80
      'febf::dead', // borde superior de fe80::/10
      'FD00::1', // ULA en MAYÚSCULAS
      '::', // unspecified
    ]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
    // IPv6 público legítimo sigue permitido (sin falsos positivos).
    for (const ip of ['2606:4700:4700::1111', '2001:4860:4860::8888', '2a00:1450:4001:81b::200e']) {
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

  // ── RA-F65B-EXT-001: material de credencial en la URL ──────────────────────
  it('rejects credential material in userinfo, query and fragment (never sanitizes silently)', () => {
    // userinfo (ya existente, se conserva).
    expect(() => assertSafeWebhookUrl('https://user:pass@example.test/hook')).toThrow(
      /credentials/
    );
    // query params con nombre sensible — exigidos por el finding.
    for (const q of [
      'token=SECRET',
      'secret=SECRET',
      'api_key=SECRET',
      'apiKey=SECRET',
      'access_token=SECRET',
      'signature=SECRET',
      'sig=SECRET',
      'key=SECRET',
      'password=SECRET',
      'auth=SECRET',
      'authorization=SECRET',
    ]) {
      expect(() => assertSafeWebhookUrl(`https://example.test/hook?${q}`), q).toThrow(
        /credential-bearing query parameter/
      );
    }
    // variantes case-insensitive.
    expect(() => assertSafeWebhookUrl('https://example.test/hook?TOKEN=x')).toThrow(
      /credential-bearing/
    );
    expect(() => assertSafeWebhookUrl('https://example.test/hook?Api-Key=x')).toThrow(
      /credential-bearing/
    );
    // nombre percent-encoded (%74oken → token) y separador legado `;`.
    expect(() => assertSafeWebhookUrl('https://example.test/hook?%74oken=x')).toThrow(
      /credential-bearing/
    );
    expect(() => assertSafeWebhookUrl('https://example.test/hook?ok=1;token=x')).toThrow(
      /credential-bearing/
    );
    // parámetros duplicados: basta con que UNO sea sensible.
    expect(() => assertSafeWebhookUrl('https://example.test/hook?a=1&a=2&client_secret=x')).toThrow(
      /credential-bearing/
    );
    // fragment.
    expect(() => assertSafeWebhookUrl('https://example.test/hook#access_token=x')).toThrow(
      /fragment/
    );
    // el error jamás copia el VALOR del secreto ni la query cruda.
    try {
      assertSafeWebhookUrl('https://example.test/hook?token=SUPERSECRETVALUE');
      expect.unreachable('debe lanzar');
    } catch (err) {
      expect(String(err)).not.toContain('SUPERSECRETVALUE');
    }
    // path secreto + fragment rechazado: el error NO refleja el path.
    try {
      assertSafeWebhookUrl('https://example.test/hooks/EXT1_PATH_SECRET_DO_NOT_LEAK#x');
      expect.unreachable('debe lanzar');
    } catch (err) {
      expect(String(err)).toMatch(/fragment/);
      expect(String(err)).not.toContain('EXT1_PATH_SECRET_DO_NOT_LEAK');
    }
    // una URL válida (incluso con query benigna) sigue aceptándose.
    expect(() => assertSafeWebhookUrl('https://example.test/hook')).not.toThrow();
    expect(() => assertSafeWebhookUrl('https://example.test/hook?ref=orders&v=2')).not.toThrow();
    // nombres benignos que comparten letras con la denylist: sin falso positivo.
    expect(() =>
      assertSafeWebhookUrl('https://example.test/hook?keyword=a&author=b')
    ).not.toThrow();
  });

  it('sanitizeUrlForDisplay strips userinfo/PATH/query/fragment; audit metadata is host + irreversible fingerprint', () => {
    expect(sanitizeUrlForDisplay('https://u:p@example.test/hook?token=S#frag')).toBe(
      'https://[REDACTED]@example.test/[REDACTED_PATH]?[REDACTED]#[REDACTED]'
    );
    // El PATH se redacta ENTERO: un token opaco colocado SOLO en el path jamás
    // sobrevive a la representación segura (no hay forma fiable de distinguir
    // un segmento benigno de un token).
    const pathOnly = sanitizeUrlForDisplay(
      'https://example.test/hooks/EXT1_PATH_SECRET_DO_NOT_LEAK'
    );
    expect(pathOnly).toBe('https://example.test/[REDACTED_PATH]');
    expect(pathOnly).not.toContain('EXT1_PATH_SECRET_DO_NOT_LEAK');
    // Host raíz sin path: se conserva scheme+host (nada que redactar).
    expect(sanitizeUrlForDisplay('https://example.test/')).toBe('https://example.test');
    expect(sanitizeUrlForDisplay('no es una url')).toBe('[unparseable URL]');

    const meta = webhookUrlAuditMetadata('https://example.test/hook?token=SECRET');
    expect(meta.url_host).toBe('example.test');
    expect(meta.url_fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(JSON.stringify(meta)).not.toContain('SECRET');
    expect(JSON.stringify(meta)).not.toContain('?');
    // misma URL → misma huella; URL distinta → huella distinta.
    expect(webhookUrlAuditMetadata('https://example.test/hook?token=SECRET')).toEqual(meta);
    expect(webhookUrlAuditMetadata('https://example.test/hook').url_fingerprint).not.toBe(
      meta.url_fingerprint
    );
  });

  it('SSRF rejection of a secret-path URL never reflects the path in the error', async () => {
    // Destino rechazado por resolver a dirección privada, con token en el PATH:
    // el error lleva la razón y la URL saneada — jamás el segmento secreto.
    try {
      await resolveSafeWebhookTarget('https://evil.example/hooks/EXT1_PATH_SECRET_DO_NOT_LEAK', {
        resolve: () => Promise.resolve(['169.254.169.254']),
      });
      expect.unreachable('debe lanzar');
    } catch (err) {
      expect(String(err)).toMatch(/non-public address/);
      expect(String(err)).not.toContain('EXT1_PATH_SECRET_DO_NOT_LEAK');
      expect(String(err)).toContain('[REDACTED_PATH]');
    }
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
