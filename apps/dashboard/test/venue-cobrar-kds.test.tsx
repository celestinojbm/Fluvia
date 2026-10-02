import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { CobrarWorkspace } from '../app/lib/venue/cobrar';
import { KitchenDisplay } from '../app/lib/venue/kds';
import type { Enablement, InPersonPayment, KitchenTicket } from '../app/lib/venue/api';

/**
 * «Cobrar» y KDS (jsdom):
 *  - sin habilitación no se puede acercar tarjeta; no existe ningún campo de
 *    número de tarjeta ni CVV;
 *  - el navegador se informa como `web` (el servidor lo declara incompatible)
 *    y el simulador queda marcado como tal;
 *  - «aprobado» solo aparece cuando el SERVIDOR devuelve `approved`;
 *  - el KDS no da por hecha una acción hasta que el servidor responde, y un
 *    conflicto de versión recarga la instantánea en vez de fingir el cambio.
 */

const ORG = '1bfed2e0-1de8-52d5-9352-0cfd7e27a5e1';
const enabled: Enablement = {
  status: 'enabled',
  provider: 'sandbox_simulator',
  reason: null,
  version: 3,
  requirements: [],
};
const payment = (over: Partial<InPersonPayment>): InPersonPayment => ({
  id: '55555555-5555-4555-8555-555555555555',
  method: 'simulator',
  provider: 'sandbox_simulator',
  simulated: true,
  state: 'preparing',
  amount: 2500,
  currency: 'USD',
  concept: null,
  payment_link_id: '66666666-6666-4666-8666-666666666666',
  payment_intent_id: null,
  failure_code: null,
  version: 1,
  created_at: '2026-10-02T00:00:00Z',
  updated_at: '2026-10-02T00:00:00Z',
  receipt: null,
  ...over,
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Cobrar (independiente)', () => {
  it('pendiente de habilitación: no permite acercar tarjeta y no pide datos de tarjeta', async () => {
    const { container } = render(
      <CobrarWorkspace
        orgId={ORG}
        merchantId="m1"
        currencies={['USD']}
        enablement={{
          ...enabled,
          status: 'pending',
          provider: 'none',
          requirements: [
            { id: 'identity', label: 'Identidad del titular verificada', done: false },
          ],
        }}
        sandbox={false}
        canConfigure
      />
    );
    await userEvent.type(screen.getByLabelText('Importe'), '25');
    expect(screen.getByRole('button', { name: 'Acercar tarjeta' })).toBeDisabled();
    expect(screen.getByText(/pendiente de habilitación/)).toBeInTheDocument();
    // Ningún campo de PAN/CVV/vencimiento en la pantalla.
    const fields = Array.from(container.querySelectorAll('input')).map(
      (i) => `${i.name} ${i.autocomplete} ${i.getAttribute('aria-label') ?? ''}`
    );
    expect(fields.join(' ')).not.toMatch(/cc-|card|cvv|cvc|pan|exp/i);
    const res = await axe.run(container, { rules: { region: { enabled: false } } });
    expect(res.violations.map((v) => v.id)).toEqual([]);
  });

  it('simulador explícito; «aprobado» solo cuando el servidor lo dice', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    let state: InPersonPayment = payment({});
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, body });
      if (url.endsWith('/in-person/devices')) {
        return json(201, {
          capability: 'incompatible',
          reasons: ['web_is_not_a_certified_terminal'],
        });
      }
      if (url.endsWith('/in-person/payments')) return json(201, state);
      if (url.endsWith('/state')) {
        state = payment({ state: body.to, version: state.version + 1 });
        return json(200, state);
      }
      if (url.endsWith('/simulate')) {
        // El servidor responde «incierto»: la pantalla NO puede decir aprobado.
        state = payment({ state: 'uncertain', version: state.version + 1 });
        return json(200, state);
      }
      return json(200, state);
    });
    render(
      <CobrarWorkspace
        orgId={ORG}
        merchantId="m1"
        currencies={['USD']}
        enablement={enabled}
        sandbox
        canConfigure
      />
    );
    await userEvent.type(screen.getByLabelText('Importe'), '25,00');
    await userEvent.click(screen.getByRole('button', { name: 'Acercar tarjeta' }));
    expect(await screen.findByText('Este dispositivo no puede leer tarjetas')).toBeInTheDocument();
    expect(calls[0]!.body).toMatchObject({ platform: 'web' });
    await userEvent.click(screen.getByRole('button', { name: 'Simular cobro (sandbox)' }));
    expect(await screen.findByText('Simulado · sin tarjeta real')).toBeInTheDocument();
    const create = calls.find((c) => c.url.endsWith('/in-person/payments'))!;
    expect(create.body).toMatchObject({
      method: 'simulator',
      source: { kind: 'amount', amount: 2500, currency: 'USD' },
    });
    expect(screen.getByRole('heading', { name: 'Acerque la tarjeta' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Proveedor aprueba' }));
    expect(
      await screen.findByRole('heading', { name: 'Resultado pendiente de confirmar' })
    ).toBeInTheDocument();
    expect(screen.queryByText('Pago aprobado')).not.toBeInTheDocument();
    expect(screen.getByText(/NO cobres de nuevo/)).toBeInTheDocument();
  });

  it('reintento tras perder la respuesta: misma client_key', async () => {
    const keys: string[] = [];
    let n = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (url.endsWith('/in-person/devices'))
        return json(201, { capability: 'incompatible', reasons: [] });
      if (url.endsWith('/in-person/payments')) {
        keys.push(body.client_key);
        if (n++ === 0) throw new TypeError('network down');
        return json(201, payment({ state: 'waiting_card' }));
      }
      return json(200, payment({ state: 'waiting_card' }));
    });
    render(
      <CobrarWorkspace
        orgId={ORG}
        merchantId="m1"
        currencies={['USD']}
        enablement={enabled}
        sandbox
        canConfigure
      />
    );
    await userEvent.type(screen.getByLabelText('Importe'), '10');
    await userEvent.click(screen.getByRole('button', { name: 'Acercar tarjeta' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Simular cobro (sandbox)' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/No hubo respuesta/);
    await userEvent.click(screen.getByRole('button', { name: 'Simular cobro (sandbox)' }));
    await screen.findByText('Simulado · sin tarjeta real');
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });
});

class FakeEventSource {
  static last: FakeEventSource | null = null;
  listeners: Record<string, Array<(e: MessageEvent) => void>> = {};
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeEventSource.last = this;
  }
  addEventListener(t: string, f: (e: MessageEvent) => void) {
    (this.listeners[t] ??= []).push(f);
  }
  emit(t: string, data: unknown) {
    for (const f of this.listeners[t] ?? []) f(new MessageEvent(t, { data: JSON.stringify(data) }));
  }
  close() {}
}

const ticket = (over: Partial<KitchenTicket>): KitchenTicket => ({
  id: '77777777-7777-4777-8777-777777777777',
  order_id: '88888888-8888-4888-8888-888888888888',
  number: 1,
  revision: 1,
  kind: 'new',
  station_code: 'cocina',
  status: 'queued',
  version: 1,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  order_number: 7,
  mode: 'dine_in',
  table_label: 'M1',
  customer_name: null,
  order_note: null,
  items: [
    {
      line_id: 'l1',
      name: 'Hamburguesa',
      quantity: 2,
      modifiers: ['Medio'],
      note: 'sin cebolla',
      voided: false,
      void_reason: null,
    },
  ],
  ...over,
});

describe('KDS', () => {
  it('no marca la acción antes de la respuesta; conflicto ⇒ recarga la instantánea', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    let snapshots = 0;
    let release: (r: Response) => void = () => {};
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('kitchen/snapshot')) {
        snapshots++;
        return json(200, {
          cursor: 1,
          tickets: [ticket(snapshots > 1 ? { status: 'accepted', version: 2 } : {})],
        });
      }
      if (url.includes('/action')) return new Promise<Response>((r) => (release = r));
      return json(200, {});
    });
    render(
      <KitchenDisplay
        orgId={ORG}
        canRecall={false}
        branches={[{ id: '99999999-9999-4999-8999-999999999999', name: 'Centro', stations: [] }]}
      />
    );
    const card = await screen.findByRole('listitem', { name: /Comanda 1, Mesa M1, Nueva/ });
    expect(within(card).getByText('sin cebolla', { exact: false })).toBeInTheDocument();
    await userEvent.click(within(card).getByRole('button', { name: 'Aceptar' }));
    // En vuelo: dice «Enviando…» y el estado sigue siendo «Nueva».
    expect(within(card).getByRole('button', { name: 'Enviando…' })).toBeDisabled();
    expect(within(card).getByText('Nueva')).toBeInTheDocument();
    // Otra pantalla se adelantó: 409 ⇒ se recarga la verdad del servidor.
    release(json(409, { error: { code: 'version_conflict' } }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Otra pantalla cambió/);
    await waitFor(() =>
      expect(screen.getByRole('listitem', { name: /Aceptada/ })).toBeInTheDocument()
    );
    // Un aviso del stream también vuelve a pedir la instantánea.
    const before = snapshots;
    FakeEventSource.last!.emit('changed', { cursor: 5 });
    await waitFor(() => expect(snapshots).toBeGreaterThan(before));
    vi.unstubAllGlobals();
  });
});
