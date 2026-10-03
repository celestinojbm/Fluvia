import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import axe from 'axe-core';
import Loading from '../app/o/[orgId]/loading';
import { DayBars, StockBadge, stockLevel } from '../app/lib/commerce-ui';

describe('piezas visuales del comercio', () => {
  it('carga: esqueleto ocupado y anunciado, accesible', async () => {
    const { container } = render(<Loading />);
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.getByRole('status').textContent).toMatch(/Cargando/);
    const r = await axe.run(container);
    expect(r.violations.map((v) => v.id)).toEqual([]);
  });

  it('existencias: agotado, quedan pocas, libres y sin control', () => {
    const p = (free: number | null) =>
      ({
        track_stock: free !== null,
        stock: free === null ? null : { on_hand: free + 1, reserved: 1, free },
      }) as const;
    expect(stockLevel(p(0))).toBe('out');
    expect(stockLevel(p(2))).toBe('low');
    expect(stockLevel(p(9))).toBe('ok');
    expect(stockLevel(p(null))).toBe('untracked');
    render(<StockBadge product={p(2)} />);
    expect(screen.getByText('Quedan 2')).toBeDefined();
  });

  it('barras diarias: tabla equivalente para lectores, con importes exactos en Bs', () => {
    render(
      <DayBars
        currency="VES"
        series={[
          {
            day: '2026-09-30',
            orders_count: 1,
            orders_amount: 123456,
            confirmed_count: 0,
            confirmed_amount: 0,
            refunded_amount: 0,
          },
          {
            day: '2026-10-01',
            orders_count: 2,
            orders_amount: 30,
            confirmed_count: 2,
            confirmed_amount: 30,
            refunded_amount: 0,
          },
        ]}
      />
    );
    const table = screen.getByRole('table', { name: /registradas y cobradas/ });
    expect(table.textContent!.replace(/\u00a0/g, ' ')).toContain('Bs 1.234,56');
    expect(table.textContent!.replace(/\u00a0/g, ' ')).toContain('Bs 0,30');
  });
});
