import { describe, expect, it } from 'vitest';
import { MAX_REDIRECT_URL_LENGTH, isSafeRedirectUrl, safeRedirectUrlOrNull } from '../src/index.js';

/**
 * success_url / cancel_url: la página alojada navega a ellas, así que solo
 * pasan URLs absolutas http(s). Casos de XSS por esquema y de ofuscación que el
 * parser WHATWG normaliza en silencio.
 */

describe('isSafeRedirectUrl', () => {
  it.each([
    'https://shop.example.com/thanks',
    'http://localhost:3000/ok',
    'https://shop.example.com/thanks?order=123&status=ok#top',
    'HTTPS://SHOP.EXAMPLE.COM/x',
    'https://[::1]:8443/ok',
    'https://xn--tienda-espaol-1nb.co/ok',
  ])('accepts %s', (url) => {
    expect(isSafeRedirectUrl(url)).toBe(true);
  });

  it.each([
    // XSS directo por esquema
    'javascript:alert(1)',
    'JavaScript:alert(document.cookie)',
    'javascript://example.com/%0Aalert(1)',
    'data:text/html,<script>alert(1)</script>',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'vbscript:msgbox(1)',
    // Otros esquemas no web
    'file:///etc/passwd',
    'ftp://example.com/file',
    'blob:https://example.com/uuid',
    'about:blank',
    'mailto:a@example.com',
    'intent://scan/#Intent;scheme=zxing;end',
    // Ofuscación que el parser WHATWG limpia en silencio
    'java\tscript:alert(1)',
    'java\nscript:alert(1)',
    'java\rscript:alert(1)',
    ' javascript:alert(1)',
    '\u0000javascript:alert(1)',
    'https://example.com/\u0000',
    'https://example.com/ ok',
    'https://example.com\u00a0/ok',
    // Relativas / sin host / malformadas
    '/thanks',
    '//evil.example.com/x',
    'https://',
    'http:/example.com',
    'https:\\\\evil.example.com/',
    'https:evil.example.com',
    'not a url',
    '',
    // Credenciales embebidas (destino disfrazado)
    'https://shop.example.com@evil.example.com/',
    'https://user:pass@shop.example.com/',
  ])('rejects %j', (url) => {
    expect(isSafeRedirectUrl(url)).toBe(false);
  });

  it('rejects non-strings and over-long values', () => {
    expect(isSafeRedirectUrl(undefined)).toBe(false);
    expect(isSafeRedirectUrl(null)).toBe(false);
    expect(isSafeRedirectUrl(42)).toBe(false);
    const base = 'https://shop.example.com/';
    expect(isSafeRedirectUrl(base + 'a'.repeat(MAX_REDIRECT_URL_LENGTH - base.length))).toBe(true);
    expect(isSafeRedirectUrl(base + 'a'.repeat(MAX_REDIRECT_URL_LENGTH - base.length + 1))).toBe(
      false
    );
  });
});

describe('safeRedirectUrlOrNull', () => {
  it('passes safe URLs through unchanged and nulls anything else', () => {
    expect(safeRedirectUrlOrNull('https://shop.example.com/ok')).toBe(
      'https://shop.example.com/ok'
    );
    expect(safeRedirectUrlOrNull('javascript:alert(1)')).toBeNull();
    expect(safeRedirectUrlOrNull(null)).toBeNull();
    expect(safeRedirectUrlOrNull(undefined)).toBeNull();
  });
});
