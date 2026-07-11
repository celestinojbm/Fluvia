import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { CreatePaymentLinkForm, CreateRefundForm } from '../app/lib/payment-actions';
import type { Merchant } from '../app/lib/api';

/**
 * F6.5A-bis — acciones de escritura por sesión (jsdom, CI-gated): confirmación
 * explícita antes de enviar, Idempotency-Key generada en el cliente y REUTILIZADA
 * en el retry del mismo intento (un reintento no duplica), estados de éxito y
 * error visibles.
 */

const MERCHANTS: Merchant[] = [
  {
    id: 'mer_112233445566',
    name: 'Tienda Norte',
    country: 'CO',
    defaultCurrency: 'COP',
    status: 'active',
    createdAt: '2026-07-01T00:00:00Z',
  },
];

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn(() =>
    Promise.resolve({
      ok: status < 400,
      status,
      clone: () => ({ json: () => Promise.resolve(body) }),
      json: () => Promise.resolve(body),
    })
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe('CreateRefundForm', () => {
  it('confirms before sending and POSTs with a client-generated Idempotency-Key', async () => {
    const fn = mockFetch(201, { id: 're_1', object: 'refund' });
    vi.stubGlobal('location', { reload: vi.fn() } as unknown as Location);
    render(<CreateRefundForm orgId="o1" paymentIntentId="pi_1" currency="COP" locale="es" />);

    await userEvent.type(screen.getByLabelText('Monto'), '20000');
    await userEvent.type(screen.getByLabelText('Motivo'), 'cliente lo pidió');
    await userEvent.click(screen.getByRole('button', { name: 'Crear reembolso' }));
    // Confirmación explícita ANTES de tocar la red.
    expect(fn).not.toHaveBeenCalled();
    expect(screen.getByText(/¿Confirmar el reembolso por/)).toBeInTheDocument();
    expect(screen.getByText('$ 20.000')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Confirmar' }));
    await waitFor(() => expect(screen.getByText('Reembolso creado ✓')).toBeInTheDocument());

    expect(fn).toHaveBeenCalledTimes(1);
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/orgs/o1/refunds');
    const headers = init.headers as Record<string, string>;
    expect(headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(String(init.body))).toEqual({
      payment_intent_id: 'pi_1',
      amount: 20_000,
      reason: 'cliente lo pidió',
    });
  });

  it('an empty amount means "all remaining" and reuses the SAME key when retrying after an error', async () => {
    const fn = mockFetch(409, { error: { code: 'refund_amount_exceeds_remaining' } });
    render(<CreateRefundForm orgId="o1" paymentIntentId="pi_1" currency="COP" locale="es" />);

    await userEvent.click(screen.getByRole('button', { name: 'Crear reembolso' }));
    expect(screen.getByText(/todo lo restante\?/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Confirmar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/refund_amount_exceeds_remaining/);
    // Retry del MISMO intento: misma Idempotency-Key (no duplica en el API).
    await userEvent.click(screen.getByRole('button', { name: 'Confirmar' }));
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(2));
    const keyOf = (call: unknown[]) =>
      ((call[1] as RequestInit).headers as Record<string, string>)['idempotency-key'];
    expect(keyOf(fn.mock.calls[0]!)).toBe(keyOf(fn.mock.calls[1]!));
    // El cuerpo sin monto no lleva `amount` (reembolso total remanente).
    const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body));
    expect(bodyOf(fn.mock.calls[0]!)).toEqual({ payment_intent_id: 'pi_1' });
  });

  it('has no structural accessibility violations (axe)', async () => {
    const { container } = render(
      <CreateRefundForm orgId="o1" paymentIntentId="pi_1" currency="COP" locale="es" />
    );
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});

describe('CreatePaymentLinkForm', () => {
  it('confirms, POSTs with an Idempotency-Key, and offers the created sandbox URL to copy', async () => {
    const fn = mockFetch(201, {
      id: 'pl_9',
      object: 'payment_link',
      url: 'http://localhost:3100/l/pl_9',
    });
    render(<CreatePaymentLinkForm orgId="o1" merchants={MERCHANTS} locale="es" />);

    await userEvent.type(screen.getByLabelText('Monto'), '15000');
    await userEvent.click(screen.getByRole('button', { name: 'Crear link' }));
    expect(fn).not.toHaveBeenCalled();
    expect(screen.getByText(/¿Confirmar la creación del payment link por/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Confirmar' }));
    await waitFor(() => expect(screen.getByText('Payment link creado ✓')).toBeInTheDocument());
    expect(screen.getByText('http://localhost:3100/l/pl_9')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copiar URL' })).toBeInTheDocument();

    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/orgs/o1/payment-links');
    expect((init.headers as Record<string, string>)['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(String(init.body))).toEqual({
      merchant_id: 'mer_112233445566',
      amount: 15_000,
      currency: 'COP',
    });
  });

  it('surfaces the API error code on failure', async () => {
    mockFetch(403, { error: { code: 'insufficient_permissions' } });
    render(<CreatePaymentLinkForm orgId="o1" merchants={MERCHANTS} locale="es" />);
    await userEvent.type(screen.getByLabelText('Monto'), '9000');
    await userEvent.click(screen.getByRole('button', { name: 'Crear link' }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirmar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/insufficient_permissions/);
  });
});
