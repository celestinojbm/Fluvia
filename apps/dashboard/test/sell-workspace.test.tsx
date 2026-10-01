import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { SellWorkspace } from '../app/lib/sell-workspace';
import type { Merchant } from '../app/lib/api';
import type { Product } from '../app/lib/commerce-api';
import { ROLE_PERMISSIONS } from '../../../packages/identity/src/rbac';
import { ROLE_ORDER, ROLE_PERMISSIONS_MIRROR } from '../app/lib/team-matrix';

/**
 * Nueva venta (jsdom): el total revisado viaja como `expected_total`; una sola
 * Idempotency-Key por carrito (misma key al reintentar tras un resultado
 * incierto; otra si cambia el carrito); un precio cambiado refresca el
 * catálogo y no crea nada; doble envío ⇒ un solo POST.
 */

const ORG = '1bfed2e0-1de8-52d5-9352-0cfd7e27a5e1';
const MERCHANT: Merchant = {
  id: 'd948f551-b02a-5154-97dc-9d9e39919cf3',
  name: 'Demo Store',
  country: 'CO',
  defaultCurrency: 'USD',
  status: 'active',
  createdAt: '2026-07-01T00:00:00Z',
};
const product = (id: string, name: string, price: number): Product => ({
  id,
  name,
  sku: null,
  description: null,
  category_id: null,
  category_name: null,
  price,
  currency: 'USD',
  available: true,
  archived: false,
  version: 1,
  created_at: '2026-07-01T00:00:00Z',
  updated_at: '2026-07-01T00:00:00Z',
  image_ref: null,
  variant_of: null,
  variant_label: null,
  track_stock: false,
  stock: null,
});
const CAFE = product('11111111-1111-4111-8111-111111111111', 'Café', 1250);
const PAN = product('22222222-2222-4222-8222-222222222222', 'Pan', 300);

const ORDER = {
  id: '33333333-3333-4333-8333-333333333333',
  number: 12,
  payment_link_id: '44444444-4444-4444-8444-444444444444',
  currency: 'USD',
  total: 2800,
  line_count: 2,
  customer_name: null,
};

type Call = { url: string; method: string; key: string | null; body: unknown };

function stubFetch(
  responder: (c: Call, n: number) => { status: number; body: unknown } | 'network'
) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const c: Call = {
        url,
        method: init?.method ?? 'GET',
        key: headers['idempotency-key'] ?? null,
        body: init?.body ? JSON.parse(init.body as string) : null,
      };
      calls.push(c);
      const r = responder(c, calls.length);
      if (r === 'network') return Promise.reject(new TypeError('network'));
      return Promise.resolve({
        ok: r.status < 400,
        status: r.status,
        json: () => Promise.resolve(r.body),
      });
    })
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

function renderSell() {
  return render(
    <SellWorkspace
      orgId={ORG}
      products={[CAFE, PAN]}
      categories={[]}
      merchants={[MERCHANT]}
      canSell
    />
  );
}

async function buildCart() {
  await userEvent.click(screen.getByRole('button', { name: /Añadir Café/ }));
  await userEvent.click(screen.getByRole('button', { name: /Añadir Café/ }));
  await userEvent.click(screen.getByRole('button', { name: /Añadir Pan/ }));
}

describe('Nueva venta', () => {
  it('total = Σ precio × cantidad; quitar y cambiar cantidad lo recalculan', async () => {
    stubFetch(() => ({ status: 500, body: {} }));
    renderSell();
    await buildCart();
    expect(document.querySelector('.fx-cart-total output')!.textContent).toMatch(/28[.,]00/);
    await userEvent.click(screen.getByRole('button', { name: 'Quitar Pan' }));
    expect(document.querySelector('.fx-cart-total output')!.textContent).toMatch(/25[.,]00/);
    const qty = screen.getByRole('group', { name: 'Cantidad de Café' });
    await userEvent.click(within(qty).getByRole('button', { name: 'Restar uno' }));
    expect(document.querySelector('.fx-cart-total output')!.textContent).toMatch(/12[.,]50/);
  });

  it('resultado incierto ⇒ carrito bloqueado; reintento seguro con la MISMA key', async () => {
    const calls = stubFetch((c, n) =>
      c.url.endsWith('/orders') && n === 1 ? 'network' : { status: 201, body: ORDER }
    );
    renderSell();
    await buildCart();
    await userEvent.click(screen.getByRole('button', { name: 'Revisar venta' }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirmar venta' }));
    expect(await screen.findByText('No sabemos si la venta se registró.')).toBeDefined();
    // Bloqueado: no se puede editar el carrito mientras tanto.
    expect(screen.getByRole('button', { name: 'Quitar Pan' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Reintentar de forma segura' }));
    expect(await screen.findByText('Venta #12 registrada')).toBeDefined();
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(posts[0]!.key).toBeTruthy();
    expect(posts[1]!.key).toBe(posts[0]!.key);
    expect(posts[0]!.body).toEqual({
      merchant_id: MERCHANT.id,
      currency: 'USD',
      lines: [
        { product_id: CAFE.id, quantity: 2 },
        { product_id: PAN.id, quantity: 1 },
      ],
      expected_total: 2800,
    });
    // «Cobrar ahora» lleva al terminal con la venta (link + pedido).
    expect(screen.getByRole('link', { name: 'Cobrar ahora' }).getAttribute('href')).toBe(
      `/o/${ORG}/pos?link=${ORDER.payment_link_id}&order=${ORDER.id}`
    );
  });

  it('precio cambiado (409) ⇒ refresca precios, no crea nada y la key siguiente es otra', async () => {
    let refreshed = false;
    const calls = stubFetch((c) => {
      if (c.method === 'GET') {
        refreshed = true;
        return { status: 200, body: { data: [{ ...CAFE, price: 1300 }, PAN] } };
      }
      return refreshed
        ? { status: 201, body: { ...ORDER, total: 2900 } }
        : { status: 409, body: { error: { code: 'order_total_changed' } } };
    });
    renderSell();
    await buildCart();
    await userEvent.click(screen.getByRole('button', { name: 'Revisar venta' }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirmar venta' }));
    expect(await screen.findByText(/Un precio cambió mientras preparabas la venta/)).toBeDefined();
    await waitFor(() =>
      expect(document.querySelector('.fx-cart-total output')!.textContent).toMatch(/29[.,]00/)
    );
    await userEvent.click(screen.getByRole('button', { name: 'Revisar venta' }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirmar venta' }));
    expect(await screen.findByText('Venta #12 registrada')).toBeDefined();
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(posts[1]!.key).not.toBe(posts[0]!.key);
    expect((posts[1]!.body as { expected_total: number }).expected_total).toBe(2900);
  });

  it('doble clic en confirmar ⇒ un solo POST', async () => {
    let resolve: ((v: unknown) => void) | null = null;
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        calls.push(url);
        return new Promise((r) => {
          resolve = r;
        });
      })
    );
    renderSell();
    await buildCart();
    await userEvent.click(screen.getByRole('button', { name: 'Revisar venta' }));
    const confirm = screen.getByRole('button', { name: 'Confirmar venta' });
    await userEvent.dblClick(confirm);
    expect(calls.filter((u) => u.endsWith('/orders'))).toHaveLength(1);
    resolve!({ ok: true, status: 201, json: () => Promise.resolve(ORDER) });
  });

  it('rol sin permiso ⇒ sin carrito; accesible (axe)', async () => {
    const { container, unmount } = render(
      <SellWorkspace
        orgId={ORG}
        products={[CAFE]}
        categories={[]}
        merchants={[MERCHANT]}
        canSell={false}
      />
    );
    expect(screen.getByText(/Tu rol no puede registrar ventas/)).toBeDefined();
    expect(screen.queryByRole('button', { name: /Añadir/ })).toBeNull();
    unmount();
    stubFetch(() => ({ status: 500, body: {} }));
    const r = renderSell();
    await buildCart();
    const result = await axe.run(r.container);
    expect(result.violations.map((v) => v.id)).toEqual([]);
    void container;
  });
});

describe('Nueva venta — variantes, existencias y SKU', () => {
  const BASE = {
    ...product('55555555-5555-4555-8555-555555555555', 'Café molido', 3500),
    sku: 'CAF-250',
    variant_label: '250 g',
    image_ref: 'catalog/cafe-grano.jpg',
    track_stock: true,
    stock: { on_hand: 2, reserved: 0, free: 2 },
  };
  const BIG = {
    ...product('66666666-6666-4666-8666-666666666666', 'Café molido', 6500),
    sku: 'CAF-500',
    variant_of: BASE.id,
    variant_label: '500 g',
    track_stock: true,
    stock: { on_hand: 1, reserved: 1, free: 0 },
  };
  const AGUA = { ...product('77777777-7777-4777-8777-777777777777', 'Agua', 200), sku: 'AGU-1' };

  function renderFam() {
    return render(
      <SellWorkspace
        orgId={ORG}
        products={[BASE, BIG, AGUA]}
        categories={[]}
        merchants={[MERCHANT]}
        canSell
      />
    );
  }

  it('una familia muestra una opción por variante; la agotada no se puede añadir', async () => {
    stubFetch(() => ({ status: 500, body: {} }));
    renderFam();
    const group = screen.getByRole('list', { name: 'Presentaciones de Café molido' });
    expect(within(group).getAllByRole('button')).toHaveLength(2);
    expect(
      screen.getByRole('button', { name: /Añadir Café molido · 500 g.*agotado/ })
    ).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: /Añadir Café molido · 250 g/ }));
    expect(screen.getByText('Café molido · 250 g', { selector: '.fx-cell-main' })).toBeDefined();
  });

  it('la cantidad no supera las existencias libres leídas (ayuda; el servidor reserva)', async () => {
    stubFetch(() => ({ status: 500, body: {} }));
    renderFam();
    const add = () =>
      userEvent.click(screen.getByRole('button', { name: /Añadir Café molido · 250 g/ }));
    await add();
    await add();
    await add(); // libre = 2
    const qty = screen.getByRole('group', { name: 'Cantidad de Café molido' });
    expect((within(qty).getByRole('spinbutton') as HTMLInputElement).value).toBe('2');
    expect(within(qty).getByRole('button', { name: 'Sumar uno' })).toBeDisabled();
  });

  it('Enter con un SKU exacto añade el producto y limpia la búsqueda', async () => {
    stubFetch(() => ({ status: 500, body: {} }));
    renderFam();
    const search = screen.getByLabelText('Buscar producto');
    await userEvent.type(search, 'agu-1{Enter}');
    expect((search as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('group', { name: 'Cantidad de Agua' })).toBeDefined();
  });

  it('sin existencias suficientes (422) ⇒ relee el catálogo y no queda nada creado', async () => {
    const calls = stubFetch((c) =>
      c.url.endsWith('/orders')
        ? { status: 422, body: { error: { code: 'insufficient_stock' } } }
        : { status: 200, body: { data: [BASE, BIG, AGUA] } }
    );
    renderFam();
    await userEvent.click(screen.getByRole('button', { name: /Añadir Café molido · 250 g/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Revisar venta' }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirmar venta' }));
    expect(await screen.findByText(/No hay existencias suficientes/)).toBeDefined();
    expect(calls.some((c) => c.method === 'GET' && c.url.endsWith('/catalog/products'))).toBe(true);
  });
});

describe('matriz de permisos del equipo', () => {
  it('espeja EXACTAMENTE la matriz RBAC del servidor', () => {
    for (const role of ROLE_ORDER) {
      expect([...ROLE_PERMISSIONS_MIRROR[role]].sort()).toEqual([...ROLE_PERMISSIONS[role]].sort());
    }
    expect([...ROLE_ORDER].sort()).toEqual(Object.keys(ROLE_PERMISSIONS).sort());
  });
});
