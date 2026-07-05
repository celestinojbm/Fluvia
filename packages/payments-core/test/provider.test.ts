import { describe, expect, it } from 'vitest';
import { MockPaymentProvider, ProviderTimeoutError } from '../src/index.js';

/** Contract tests del adapter simulado (F3-03): deterministico e inyectable. */
describe('MockPaymentProvider', () => {
  const provider = new MockPaymentProvider();
  const base = { attemptId: 'att-1', amount: '100000', currency: 'COP' };

  it('tok_approve approves with a deterministic provider ref', async () => {
    const a = await provider.submitPayment({ ...base, paymentMethodToken: 'tok_approve' });
    const b = await provider.submitPayment({ ...base, paymentMethodToken: 'tok_approve' });
    expect(a.outcome).toBe('approved');
    expect(a.providerRef).toMatch(/^mock_[0-9a-f]{24}$/);
    expect(a.providerRef).toBe(b.providerRef); // mismo attempt -> misma ref
    const other = await provider.submitPayment({
      ...base,
      attemptId: 'att-2',
      paymentMethodToken: 'tok_approve',
    });
    expect(other.providerRef).not.toBe(a.providerRef);
  });

  it('decline tokens return stable failure codes', async () => {
    const d = await provider.submitPayment({ ...base, paymentMethodToken: 'tok_decline' });
    expect(d).toMatchObject({ outcome: 'declined', failureCode: 'card_declined' });
    const i = await provider.submitPayment({
      ...base,
      paymentMethodToken: 'tok_decline_insufficient',
    });
    expect(i).toMatchObject({ outcome: 'declined', failureCode: 'insufficient_funds' });
  });

  it('unknown tokens decline as invalid_payment_method (never approve by accident)', async () => {
    const u = await provider.submitPayment({ ...base, paymentMethodToken: 'tok_whatever' });
    expect(u).toMatchObject({ outcome: 'declined', failureCode: 'invalid_payment_method' });
  });

  it('tok_timeout throws: outcome UNKNOWN, caller must go indeterminate (V4 §23)', async () => {
    await expect(
      provider.submitPayment({ ...base, paymentMethodToken: 'tok_timeout' })
    ).rejects.toThrow(ProviderTimeoutError);
  });
});
