import { describe, expect, it } from 'vitest';
import { CURRENCY_CODES } from '../../../packages/money/src/currency';
import { parseMajorAmount, POS_CURRENCIES } from '../app/lib/pos-money';
import { classifySale, isTerminalPhase, pickPayment, pickSession } from '../app/lib/pos-contract';
import { displayExponent, formatAmount } from '../app/messages';

/**
 * POS sandbox — lógica pura: conversión de importes, contrato de estado y
 * clasificación de fases. Sin red ni navegador.
 */

describe('parseMajorAmount', () => {
  it('convierte unidades mayores a menores con el exponente de VISUALIZACIÓN', () => {
    expect(parseMajorAmount('12.50', 'USD')).toEqual({ ok: true, minor: 1250 });
    expect(parseMajorAmount('12,5', 'EUR')).toEqual({ ok: true, minor: 1250 });
    expect(parseMajorAmount(' 7 ', 'USD')).toEqual({ ok: true, minor: 700 });
    expect(parseMajorAmount('12500', 'COP')).toEqual({ ok: true, minor: 12500 });
    expect(parseMajorAmount('0.01', 'USD')).toEqual({ ok: true, minor: 1 });
  });

  it('lo tecleado y lo mostrado coinciden (round-trip con formatAmount)', () => {
    const shown = (text: string, cur: string) => {
      const r = parseMajorAmount(text, cur);
      if (!r.ok) throw new Error(r.error);
      return formatAmount(r.minor, cur, 'en');
    };
    expect(shown('12.50', 'USD')).toBe('$12.50');
    expect(shown('12500', 'COP')).toContain('12,500');
    expect(shown('3', 'JPY')).toContain('3');
  });

  it('rechaza entradas ambiguas o inválidas sin adivinar', () => {
    expect(parseMajorAmount('', 'USD')).toEqual({ ok: false, error: 'empty' });
    expect(parseMajorAmount('abc', 'USD')).toEqual({ ok: false, error: 'format' });
    expect(parseMajorAmount('-5', 'USD')).toEqual({ ok: false, error: 'format' });
    expect(parseMajorAmount('1.234.567', 'USD')).toEqual({ ok: false, error: 'format' });
    expect(parseMajorAmount('1e3', 'USD')).toEqual({ ok: false, error: 'format' });
    expect(parseMajorAmount('12.5', 'COP')).toEqual({ ok: false, error: 'decimals' });
    expect(parseMajorAmount('1.005', 'USD')).toEqual({ ok: false, error: 'decimals' });
    expect(parseMajorAmount('0', 'USD')).toEqual({ ok: false, error: 'zero' });
    expect(parseMajorAmount('0.00', 'USD')).toEqual({ ok: false, error: 'zero' });
    expect(parseMajorAmount('90071992547409.92', 'USD')).toEqual({ ok: false, error: 'too_large' });
  });

  it('la lista de monedas del POS es EXACTAMENTE el registro de @fluvia/money', () => {
    expect([...POS_CURRENCIES].sort()).toEqual([...CURRENCY_CODES].sort());
  });

  it('fija la discrepancia conocida de COP (UI 0 vs dominio 2) — decisión pendiente', () => {
    // Si alguien alinea la UI con @fluvia/money, este test debe cambiar a la
    // vez que formatAmount y el POS (una sola regla). Ver docs/product.
    expect(displayExponent('COP')).toBe(0);
    expect(displayExponent('USD')).toBe(2);
  });
});

const SESSION = {
  id: '11111111-1111-4111-8111-111111111111',
  object: 'checkout_session',
  payment_intent_id: '22222222-2222-4222-8222-222222222222',
  status: 'open',
  url: 'http://x/c/1',
  expires_at: '2026-09-30T00:00:00Z',
  completed_at: null,
  created_at: '2026-09-29T00:00:00Z',
  client_secret: 'cs_should_not_pass',
};
const INTENT = {
  id: '22222222-2222-4222-8222-222222222222',
  merchant_id: 'm-1',
  amount: 1250,
  currency: 'USD',
  status: 'created',
  failure_code: null,
  amount_refunded: 0,
  capture_method: 'automatic',
};

describe('contrato de estado (whitelist)', () => {
  it('reconstruye solo los campos permitidos', () => {
    const s = pickSession(SESSION);
    expect(s).toEqual({
      id: SESSION.id,
      status: 'open',
      expires_at: SESSION.expires_at,
      completed_at: null,
      created_at: SESSION.created_at,
    });
    expect(JSON.stringify(s)).not.toContain('cs_should_not_pass');
    expect(pickPayment(INTENT)).not.toHaveProperty('capture_method');
  });

  it('rechaza cuerpos malformados', () => {
    expect(pickSession(null)).toBeNull();
    expect(pickSession({ ...SESSION, id: 'no-uuid' })).toBeNull();
    expect(pickSession({ ...SESSION, payment_intent_id: undefined })).toBeNull();
    expect(pickPayment({ ...INTENT, amount: '1250' })).toBeNull();
    expect(pickPayment({ ...INTENT, amount: 1.5 })).toBeNull();
    expect(pickPayment([])).toBeNull();
  });
});

describe('classifySale', () => {
  it.each([
    ['open', 'created', 'awaiting_payment'],
    ['open', 'requires_confirmation', 'awaiting_payment'],
    ['open', 'processing', 'processing'],
    ['open', 'requires_action', 'processing'],
    ['expired', 'processing', 'processing'],
    ['completed', 'succeeded', 'succeeded'],
    ['completed', 'refunded', 'succeeded'],
    ['open', 'failed', 'failed'],
    ['open', 'canceled', 'canceled'],
    ['expired', 'created', 'expired'],
    ['open', 'weird_new_state', 'unknown'],
  ])('sesión %s + intent %s ⇒ %s', (s, i, expected) => {
    expect(classifySale(s, i)).toBe(expected);
  });

  it('solo los desenlaces verificados son terminales', () => {
    expect(isTerminalPhase('succeeded')).toBe(true);
    expect(isTerminalPhase('failed')).toBe(true);
    expect(isTerminalPhase('processing')).toBe(false);
    expect(isTerminalPhase('unknown')).toBe(false);
  });
});
