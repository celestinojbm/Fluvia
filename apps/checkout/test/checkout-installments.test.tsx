import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { CheckoutClient } from '../app/checkout-client';
import { PlanClient } from '../app/plan-client';

/**
 * Comprador: resumen de compra con líneas, «Pagar en cuotas» (SIMULACIÓN) con
 * confirmación explícita, y plan vivo que impide pagar con otro método.
 */

const OPEN_VIEW = {
  id: 's1',
  status: 'open',
  payment_intent: { id: 'pi1', status: 'requires_payment_method', amount: 10_000, currency: 'USD' },
};
const COMPLETED_VIEW = {
  ...OPEN_VIEW,
  status: 'completed',
  payment_intent: { ...OPEN_VIEW.payment_intent, status: 'succeeded' },
};

const ORDER = {
  number: 7,
  merchant_name: 'Tienda Demo',
  currency: 'USD',
  total: 10_000,
  lines: [
    { position: 1, name: 'Café 500 g', unit_price: 2_500, quantity: 2, line_total: 5_000 },
    { position: 2, name: 'Taza', unit_price: 5_000, quantity: 1, line_total: 5_000 },
  ],
};
const PLAN = {
  id: 'p1',
  status: 'approved',
  currency: 'USD',
  total: 10_000,
  installments_count: 3,
  interval_days: 15,
  terms_version: 'demo-2026-10',
  installments: [
    { seq: 1, amount: 3_334, due_date: '2026-10-01', status: 'scheduled' },
    { seq: 2, amount: 3_333, due_date: '2026-10-16', status: 'scheduled' },
    { seq: 3, amount: 3_333, due_date: '2026-10-31', status: 'scheduled' },
  ],
  events: [{ kind: 'plan_requested', seq: null, created_at: '2026-10-01T10:00:00Z' }],
};
const orderView = (plan: unknown = null, eligible = true) => ({
  object: 'checkout_order',
  order: ORDER,
  installments: {
    simulated: true,
    eligible,
    ineligible_reason: eligible ? null : 'plan_exists',
    allowed_counts: [3, 4, 6],
    interval_days: 15,
    terms_version: 'demo-2026-10',
    plan,
  },
});
const QUOTE = {
  count: 3,
  currency: 'USD',
  total: 10_000,
  initial_amount: 3_334,
  interval_days: 15,
  terms_version: 'demo-2026-10',
  schedule: PLAN.installments.map(({ seq, amount, due_date }) => ({ seq, amount, due_date })),
};

type Route = (url: string, init?: RequestInit) => { status?: number; body: unknown };
function mockRoutes(route: Route) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const r = route(url, init);
      const status = r.status ?? 200;
      return Promise.resolve({
        ok: status < 400,
        status,
        json: () => Promise.resolve(r.body),
        text: () => Promise.resolve(JSON.stringify(r.body)),
      });
    })
  );
}

beforeEach(() => {
  window.location.hash = '#cs_secret_123';
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resumen de compra', () => {
  it('muestra las líneas y el total del pedido; sin pedido (404) no muestra resumen', async () => {
    mockRoutes((url) => (url.endsWith('/order') ? { body: orderView() } : { body: OPEN_VIEW }));
    const { unmount } = render(<CheckoutClient sessionId="s1" locale="es" />);
    const summary = await screen.findByRole('region', { name: 'Resumen de tu compra' });
    expect(within(summary).getByText('Café 500 g')).toBeDefined();
    expect(within(summary).getByText('Compra #7', { exact: false })).toBeDefined();
    unmount();

    mockRoutes((url) => (url.endsWith('/order') ? { status: 404, body: {} } : { body: OPEN_VIEW }));
    render(<CheckoutClient sessionId="s1" locale="es" />);
    await screen.findByRole('button', { name: 'Pagar' });
    expect(screen.queryByRole('region', { name: 'Resumen de tu compra' })).toBeNull();
    expect(screen.queryByRole('region', { name: /Pagar en cuotas/ })).toBeNull();
  });

  it('pagado ⇒ comprobante (no factura) con botón de imprimir', async () => {
    mockRoutes((url) =>
      url.endsWith('/order') ? { body: orderView(null, false) } : { body: COMPLETED_VIEW }
    );
    render(<CheckoutClient sessionId="s1" locale="es" />);
    expect(await screen.findByRole('region', { name: 'Comprobante de compra' })).toBeDefined();
    expect(screen.getByText(/No es una factura/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Imprimir comprobante' })).toBeDefined();
  });
});

describe('pagar en cuotas (simulación)', () => {
  it('exige aceptación explícita y envía accept_terms: true con el escenario elegido', async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    let planCreated = false;
    mockRoutes((url, init) => {
      calls.push({ url, body: init?.body as string | undefined });
      if (url.endsWith('/installments/quote')) return { body: QUOTE };
      if (url.endsWith('/installments')) {
        planCreated = true;
        return { status: 201, body: PLAN };
      }
      if (url.endsWith('/order'))
        return { body: planCreated ? orderView(PLAN, false) : orderView() };
      return { body: OPEN_VIEW };
    });
    render(<CheckoutClient sessionId="s1" locale="es" />);
    const section = await screen.findByRole('region', { name: /Pagar en cuotas/ });
    expect(within(section).getByText(/no hay financiación ni crédito real/)).toBeDefined();
    await userEvent.click(within(section).getByRole('button', { name: 'Ver opción de cuotas' }));
    await userEvent.click(within(section).getByRole('radio', { name: /3 cuotas/ }));
    expect(await within(section).findByText('Importe inicial (hoy)')).toBeDefined();
    await userEvent.click(within(section).getByRole('radio', { name: 'Pendiente de revisión' }));

    // Sin marcar la aceptación: no se envía nada.
    await userEvent.click(
      within(section).getByRole('button', { name: 'Confirmar plan en cuotas' })
    );
    expect(within(section).getByText('Debes aceptar explícitamente para continuar.')).toBeDefined();
    expect(calls.some((c) => c.url.endsWith('/installments'))).toBe(false);

    await userEvent.click(within(section).getByRole('checkbox'));
    await userEvent.click(
      within(section).getByRole('button', { name: 'Confirmar plan en cuotas' })
    );
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/installments'))).toBe(true));
    const sent = JSON.parse(calls.find((c) => c.url.endsWith('/installments'))!.body!);
    expect(sent).toEqual({ count: 3, scenario: 'pending', accept_terms: true });

    // Con el plan vivo: sin formulario de tarjeta, aviso de que NO es un pago.
    expect(
      await screen.findByRole('region', { name: 'Tu plan de cuotas (simulación)' })
    ).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Pagar' })).toBeNull();
    expect(screen.getByText(/la compra no queda pagada por este plan/)).toBeDefined();
  });

  it('confirm con tarjeta rechazado por un plan activo (409) relee, nunca «incierto»', async () => {
    let confirmCalled = false;
    mockRoutes((url) => {
      if (url.endsWith('/confirm')) {
        confirmCalled = true;
        return { status: 409, body: { error: { code: 'installment_plan_active' } } };
      }
      if (url.endsWith('/order'))
        return { body: confirmCalled ? orderView(PLAN, false) : orderView() };
      return { body: OPEN_VIEW };
    });
    render(<CheckoutClient sessionId="s1" locale="es" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Pagar' }));
    expect(
      await screen.findByRole('region', { name: 'Tu plan de cuotas (simulación)' })
    ).toBeDefined();
    expect(screen.queryByText(/No pudimos confirmar el resultado del pago/)).toBeNull();
  });

  it('sin violaciones axe en el checkout con resumen y cuotas abiertas', async () => {
    mockRoutes((url) =>
      url.endsWith('/installments/quote')
        ? { body: QUOTE }
        : url.endsWith('/order')
          ? { body: orderView() }
          : { body: OPEN_VIEW }
    );
    const { container } = render(<CheckoutClient sessionId="s1" locale="es" />);
    const section = await screen.findByRole('region', { name: /Pagar en cuotas/ });
    await userEvent.click(within(section).getByRole('button', { name: 'Ver opción de cuotas' }));
    await within(section).findByText('Importe inicial (hoy)');
    const result = await axe.run(container);
    expect(result.violations.map((v) => v.id)).toEqual([]);
  });
});

describe('consulta del plan por el comprador', () => {
  it('muestra calendario, historial y la advertencia de simulación', async () => {
    mockRoutes(() => ({ body: orderView(PLAN, false) }));
    render(<PlanClient sessionId="s1" locale="es" />);
    expect(await screen.findByText('Plan aprobado por el proveedor simulado.')).toBeDefined();
    expect(screen.getByText('Confirmaste el plan')).toBeDefined();
    expect(screen.getAllByText(/Programada/).length).toBe(3);
    expect(fetch).toHaveBeenCalledWith(
      '/api/checkout/s1/order',
      expect.objectContaining({ headers: { 'x-checkout-client-secret': 'cs_secret_123' } })
    );
  });

  it('secreto inválido ⇒ enlace inválido', async () => {
    mockRoutes(() => ({ status: 404, body: {} }));
    render(<PlanClient sessionId="s1" locale="es" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('inválido');
  });
});

describe('bolívares y venta anulada', () => {
  const VES_VIEW = {
    ...OPEN_VIEW,
    payment_intent: { ...OPEN_VIEW.payment_intent, amount: 370_398, currency: 'VES' },
  };
  const VES_ORDER = {
    ...ORDER,
    merchant_name: 'Bodega Caracas',
    currency: 'VES',
    total: 370_398,
    lines: [
      {
        position: 1,
        name: 'Café molido',
        variant_label: '500 g',
        unit_price: 123_456,
        quantity: 3,
        line_total: 370_368,
      },
      { position: 2, name: 'Caramelo', unit_price: 30, quantity: 1, line_total: 30 },
    ],
  };

  it('importe en Bs. con código, variante en la línea y el comercio en la cabecera', async () => {
    mockRoutes((url) =>
      url.endsWith('/order') ? { body: { ...orderView(), order: VES_ORDER } } : { body: VES_VIEW }
    );
    render(<CheckoutClient sessionId="s1" locale="es" />);
    const amount = await screen.findByTestId('amount');
    expect(amount.textContent!.replace(/ /g, ' ')).toBe('Bs. 3.703,98 VES');
    expect(await screen.findByText('Café molido · 500 g', { exact: false })).toBeDefined();
    expect(document.querySelector('.co-merchant')!.textContent).toContain('Bodega Caracas');
  });

  it('venta anulada por el comercio: sin formulario de pago ni cuotas', async () => {
    mockRoutes((url) =>
      url.endsWith('/order')
        ? { body: { ...orderView(null, false), order: { ...ORDER, cancelled: true } } }
        : { body: OPEN_VIEW }
    );
    const { container } = render(<CheckoutClient sessionId="s1" locale="es" />);
    expect(await screen.findByText(/El comercio anuló esta compra/)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Pagar' })).toBeNull();
    const result = await axe.run(container);
    expect(result.violations.map((v) => v.id)).toEqual([]);
  });

  it('409 order_cancelled al pagar ⇒ relee la vista (no queda «incierto»)', async () => {
    let cancelled = false;
    mockRoutes((url) => {
      if (url.endsWith('/confirm')) {
        cancelled = true;
        return { status: 409, body: { error: { code: 'order_cancelled' } } };
      }
      if (url.endsWith('/order')) {
        return { body: { ...orderView(), order: { ...ORDER, cancelled } } };
      }
      return { body: OPEN_VIEW };
    });
    render(<CheckoutClient sessionId="s1" locale="es" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Pagar' }));
    expect(await screen.findByText(/El comercio anuló esta compra/)).toBeDefined();
    expect(screen.queryByText(/No pudimos confirmar el resultado/)).toBeNull();
  });
});
