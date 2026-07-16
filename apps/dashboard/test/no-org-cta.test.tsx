import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { NoOrgCta } from '../app/lib/no-org-cta';

/**
 * F6.5C1 — estado VALIDO de usuario sin organizacion: CTA informativa hacia el
 * futuro onboarding sandbox (F6.5C2, no implementado). Sin enlaces (no se deja
 * un enlace roto) y sin creacion automatica de datos.
 */

describe('NoOrgCta', () => {
  it('renders the CTA copy accessibly (axe clean)', async () => {
    const { container } = render(<NoOrgCta locale="es" />);
    expect(screen.getByRole('heading', { name: 'Tu cuenta está lista' })).toBeInTheDocument();
    expect(screen.getByText('No perteneces a ninguna organización.')).toBeInTheDocument();
    expect(screen.getByText(/onboarding sandbox/)).toBeInTheDocument();
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });

  it('has NO links: the org onboarding route does not exist yet (no broken links)', () => {
    render(<NoOrgCta locale="es" />);
    expect(screen.queryAllByRole('link')).toEqual([]);
  });

  it('renders in english too', () => {
    render(<NoOrgCta locale="en" />);
    expect(screen.getByRole('heading', { name: 'Your account is ready' })).toBeInTheDocument();
  });
});
