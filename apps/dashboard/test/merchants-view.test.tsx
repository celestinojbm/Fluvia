import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { MerchantsList } from '../app/lib/merchants-view';
import type { Merchant } from '../app/lib/api';

/**
 * F4-04a — vista «buscar comercios» del panel admin (jsdom + axe, CI-gated). El
 * filtrado en sí se prueba como lógica pura (`filterMerchants` en api.test); aquí
 * se verifica el marcado, la búsqueda accesible y los dos estados vacíos.
 */

const MERCHANTS: Merchant[] = [
  {
    id: 'mer_abcdef123456',
    name: 'Tienda Norte',
    country: 'CO',
    defaultCurrency: 'COP',
    status: 'active',
    createdAt: '2026-07-06T10:00:00Z',
  },
  {
    id: 'mer_frozen0001',
    name: 'Comercio Congelado',
    country: 'CO',
    defaultCurrency: 'COP',
    status: 'frozen',
    createdAt: '2026-07-05T10:00:00Z',
  },
];

describe('MerchantsList', () => {
  it('renders the merchants with a labelled search form and status labels', () => {
    render(
      <MerchantsList
        merchants={MERCHANTS}
        hasAny
        orgId="o1"
        query=""
        locale="es"
        signOutHref="/logout"
      />
    );
    // Búsqueda accesible.
    const search = screen.getByRole('searchbox', { name: 'Buscar comercios' });
    expect(search).toBeInTheDocument();
    // Comercio y estado traducido.
    expect(screen.getByText('Tienda Norte')).toBeInTheDocument();
    expect(screen.getByText('Activo')).toBeInTheDocument();
    expect(screen.getByText('Congelado')).toBeInTheDocument();
    // Sin query no hay enlace de limpiar.
    expect(screen.queryByRole('link', { name: 'Limpiar' })).toBeNull();
  });

  it('reflects the active query and offers a clear link', () => {
    render(
      <MerchantsList
        merchants={[MERCHANTS[0]!]}
        hasAny
        orgId="o1"
        query="norte"
        locale="es"
        signOutHref="/logout"
      />
    );
    expect(screen.getByRole('searchbox', { name: 'Buscar comercios' })).toHaveValue('norte');
    expect(screen.getByRole('link', { name: 'Limpiar' }).getAttribute('href')).toBe(
      '/o/o1/merchants'
    );
  });

  it('distinguishes "no merchants" from "no search match"', () => {
    const { rerender } = render(
      <MerchantsList
        merchants={[]}
        hasAny={false}
        orgId="o1"
        query=""
        locale="es"
        signOutHref="/logout"
      />
    );
    expect(screen.getByText('No hay comercios en esta organización.')).toBeInTheDocument();

    rerender(
      <MerchantsList
        merchants={[]}
        hasAny
        orgId="o1"
        query="zzz"
        locale="es"
        signOutHref="/logout"
      />
    );
    expect(screen.getByText('Ningún comercio coincide con la búsqueda.')).toBeInTheDocument();
  });

  it('has no structural accessibility violations (axe)', async () => {
    const { container } = render(
      <MerchantsList
        merchants={MERCHANTS}
        hasAny
        orgId="o1"
        query="norte"
        locale="es"
        signOutHref="/logout"
      />
    );
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});
