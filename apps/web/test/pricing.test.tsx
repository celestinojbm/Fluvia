import { render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import PreciosPage from '../app/precios/page';
import { MotionRoot } from '../app/components/motion';

describe('precios de ejemplo', () => {
  it('no muestra cifras: comisión al comercio y Próximamente', () => {
    render(
      <MotionRoot>
        <PreciosPage />
      </MotionRoot>
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Precios' })).toBeInTheDocument();
    expect(screen.getByText('Comisión al comercio · Próximamente')).toBeInTheDocument();
    expect(screen.getByText('Próximamente', { selector: '.price' })).toBeInTheDocument();
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/\d\s*%|%\s*\d/);
    expect(text).not.toMatch(
      /(Bs\.?|USD|\$|€)\s*\d|\d[\d.,]*\s*(Bs\b|USD|bol[ií]vares|d[oó]lares)/i
    );
  });

  it('no tiene violaciones estructurales de axe', async () => {
    const { container } = render(
      <MotionRoot>
        <PreciosPage />
      </MotionRoot>
    );
    const results = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});
