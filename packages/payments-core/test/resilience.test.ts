import { describe, expect, it } from 'vitest';
import {
  CircuitOpenError,
  MockPaymentProvider,
  ProviderTimeoutError,
  ResilientProvider,
  type PaymentProvider,
  type ProviderOutcome,
} from '../src/index.js';

/** Proveedor de laboratorio: falla o tarda a demanda. */
function flaky(behavior: () => Promise<ProviderOutcome>): PaymentProvider {
  return { name: 'mock', submitPayment: behavior };
}

const base = { attemptId: 'att-1', amount: '1000', currency: 'COP', paymentMethodToken: 'x' };
const approved: ProviderOutcome = { outcome: 'approved', providerRef: 'mock_ok' };

describe('ResilientProvider (F3-04)', () => {
  it('enforces a hard timeout: a hung provider becomes ProviderTimeoutError', async () => {
    const hung = flaky(() => new Promise<never>(() => undefined));
    const p = new ResilientProvider(hung, { timeoutMs: 30 });
    await expect(p.submitPayment(base)).rejects.toThrow(ProviderTimeoutError);
  });

  it('opens after N consecutive failures and rejects INSTANTLY while open', async () => {
    const clock = 0;
    const failing = flaky(() => Promise.reject(new ProviderTimeoutError('mock')));
    const p = new ResilientProvider(failing, {
      failureThreshold: 3,
      cooldownMs: 30_000,
      now: () => clock,
    });
    for (let i = 0; i < 3; i += 1) {
      await expect(p.submitPayment(base)).rejects.toThrow(ProviderTimeoutError);
    }
    expect(p.circuitState).toBe('open');
    // Abierto: rechaza sin tocar al proveedor (CircuitOpenError, no timeout).
    await expect(p.submitPayment(base)).rejects.toThrow(CircuitOpenError);
  });

  it('half-open after cooldown: a successful probe closes, a failing probe reopens', async () => {
    let clock = 0;
    let fail = true;
    const p = new ResilientProvider(
      flaky(() => (fail ? Promise.reject(new Error('boom')) : Promise.resolve(approved))),
      { failureThreshold: 1, cooldownMs: 10_000, now: () => clock }
    );
    await expect(p.submitPayment(base)).rejects.toThrow('boom');
    expect(p.circuitState).toBe('open');

    // Sonda fallida: reabre y el reloj de cooldown se reinicia.
    clock = 10_000;
    await expect(p.submitPayment(base)).rejects.toThrow('boom');
    expect(p.circuitState).toBe('open');
    clock = 15_000; // cooldown NO cumplido desde la reapertura
    await expect(p.submitPayment(base)).rejects.toThrow(CircuitOpenError);

    // Sonda exitosa: cierra.
    fail = false;
    clock = 20_001;
    await expect(p.submitPayment(base)).resolves.toEqual(approved);
    expect(p.circuitState).toBe('closed');
  });

  it('declines do NOT count as circuit failures (the provider is alive)', async () => {
    const declining = new MockPaymentProvider();
    const p = new ResilientProvider(declining, { failureThreshold: 1 });
    for (let i = 0; i < 5; i += 1) {
      const out = await p.submitPayment({ ...base, paymentMethodToken: 'tok_decline' });
      expect(out.outcome).toBe('declined');
    }
    expect(p.circuitState).toBe('closed');
  });

  it('a success resets the consecutive-failure counter', async () => {
    let calls = 0;
    const p = new ResilientProvider(
      flaky(() => {
        calls += 1;
        return calls % 2 === 0 ? Promise.resolve(approved) : Promise.reject(new Error('x'));
      }),
      { failureThreshold: 2 }
    );
    // falla, exito, falla, exito... jamas 2 fallos consecutivos => cerrado.
    for (let i = 0; i < 6; i += 1) {
      await p.submitPayment(base).catch(() => undefined);
    }
    expect(p.circuitState).toBe('closed');
  });
});
