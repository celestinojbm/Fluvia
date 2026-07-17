import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { NoOrgCta } from '../app/lib/no-org-cta';

/**
 * F6.5C1/C2 — estado VALIDO de usuario sin organizacion: CTA con enlace al
 * wizard de onboarding sandbox (`/onboarding`, implementado en F6.5C2).
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

  it('links to /onboarding (no broken links; lang preserved in english)', () => {
    const { unmount } = render(<NoOrgCta locale="es" />);
    expect(screen.getByRole('link', { name: 'Crear tu organización →' })).toHaveAttribute(
      'href',
      '/onboarding'
    );
    unmount();
    render(<NoOrgCta locale="en" />);
    expect(screen.getByRole('link', { name: 'Create your organization →' })).toHaveAttribute(
      'href',
      '/onboarding?lang=en'
    );
  });

  it('renders in english too', () => {
    render(<NoOrgCta locale="en" />);
    expect(screen.getByRole('heading', { name: 'Your account is ready' })).toBeInTheDocument();
  });
});
