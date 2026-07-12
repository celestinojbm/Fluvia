import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { ApiKeysList } from '../app/lib/api-keys-view';
import type { ApiKey } from '../app/lib/api';

/**
 * F6.5B — vista de API keys (jsdom + axe, CI-gated). SOLO LECTURA: el serializer
 * del API nunca devuelve el secreto ni su hash, y esta vista solo mapea metadata.
 * El test de seguridad falla si un campo secreto inyectado se filtrara al DOM.
 */

const ACTIVE: ApiKey = {
  id: 'ak_abcdef123456',
  label: 'CI backend',
  key_prefix: 'fluvia_sk_test_ab12',
  scopes: ['read', 'payments:write'],
  environment: 'test',
  created_at: '2026-07-10T09:00:00Z',
  last_used_at: '2026-07-11T08:00:00Z',
  revoked_at: null,
};

const REVOKED: ApiKey = {
  ...ACTIVE,
  id: 'ak_zzzzzz999999',
  label: 'old key',
  key_prefix: 'fluvia_sk_test_zz99',
  last_used_at: null,
  revoked_at: '2026-07-11T09:00:00Z',
};

describe('ApiKeysList', () => {
  it('lists keys with label/prefix/scopes/status and shows the empty state', () => {
    const { rerender } = render(
      <ApiKeysList keys={[ACTIVE, REVOKED]} orgId="o1" locale="es" signOutHref="/logout" />
    );
    expect(screen.getByText('CI backend')).toBeInTheDocument();
    expect(screen.getByText('fluvia_sk_test_ab12…')).toBeInTheDocument();
    // Ambas keys comparten scopes (REVOKED hereda de ACTIVE): dos celdas.
    expect(screen.getAllByText('read, payments:write')).toHaveLength(2);
    expect(screen.getByText('Activa')).toBeInTheDocument();
    expect(screen.getByText('Revocada')).toBeInTheDocument();

    rerender(<ApiKeysList keys={[]} orgId="o1" locale="es" signOutHref="/logout" />);
    expect(screen.getByText('Sin API keys.')).toBeInTheDocument();
  });

  it('declares its read-only nature and that the secret is never shown; renders no mutating controls', () => {
    render(<ApiKeysList keys={[ACTIVE]} orgId="o1" locale="es" signOutHref="/logout" />);
    expect(screen.getByText(/Vista de solo lectura/)).toBeInTheDocument();
    expect(screen.getByText(/El secreto de una API key jamás se muestra/)).toBeInTheDocument();
    expect(screen.queryAllByRole('button')).toEqual([]);
  });

  it('offers create + revoke controls only with canManage (keys:manage)', () => {
    const { rerender } = render(
      <ApiKeysList keys={[ACTIVE, REVOKED]} orgId="o1" locale="es" signOutHref="/logout" />
    );
    expect(screen.queryByRole('button', { name: 'Crear API key' })).toBeNull();
    expect(screen.getByText(/Tu rol no permite crear ni revocar/)).toBeInTheDocument();

    rerender(
      <ApiKeysList keys={[ACTIVE, REVOKED]} orgId="o1" locale="es" signOutHref="/logout" canManage />
    );
    expect(screen.getByRole('button', { name: 'Crear API key' })).toBeInTheDocument();
    // Revocar visible solo para la key activa (la revocada muestra '—').
    expect(screen.getAllByRole('button', { name: 'Revocar' })).toHaveLength(1);
    expect(screen.queryByText(/Vista de solo lectura/)).not.toBeInTheDocument();
  });

  it('SECURITY: a secret-like field injected into a key never reaches the DOM', () => {
    const poisoned = {
      ...ACTIVE,
      secret: 'fluvia_sk_test_SUPERSECRET',
      secret_hash: 'deadbeefhash',
      hashed_secret: 'anotherhash',
    } as unknown as ApiKey;
    const { container } = render(
      <ApiKeysList keys={[poisoned]} orgId="o1" locale="es" signOutHref="/logout" />
    );
    const html = container.innerHTML;
    expect(html).not.toContain('fluvia_sk_test_SUPERSECRET');
    expect(html).not.toContain('deadbeefhash');
    expect(html).not.toContain('anotherhash');
    // El prefijo SÍ se muestra (es público) — confirma que la vista sí renderiza.
    expect(html).toContain('fluvia_sk_test_ab12');
  });

  it('has no structural accessibility violations (axe)', async () => {
    const { container } = render(
      <ApiKeysList keys={[ACTIVE, REVOKED]} orgId="o1" locale="es" signOutHref="/logout" />
    );
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});
