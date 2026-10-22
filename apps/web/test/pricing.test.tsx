import { render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import PreciosPage from '../app/precios/page';
import { MotionRoot } from '../app/components/motion';

describe('precios de ejemplo', () => {
  it('marca las tarifas como ilustrativas y el 1,9 % como ejemplo', () => {
    render(
      <MotionRoot>
        <PreciosPage />
      </MotionRoot>
    );
    expect(screen.getByRole('heading', { level: 1, name: /Precios que/ })).toBeInTheDocument();
    expect(screen.getByText(/Tarifas ilustrativas · por definir/)).toBeInTheDocument();
    expect(screen.getByText('1,9 %')).toBeInTheDocument();
    expect(screen.getByText(/Cifra de ejemplo. No es una tarifa vigente./)).toBeInTheDocument();
    expect(screen.getByText(/ejemplo/i, { selector: '.price-detail' })).toBeInTheDocument();
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
