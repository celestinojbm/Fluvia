import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Button } from '../app/components/button';

describe('botón Menta', () => {
  it('deshabilitado no se puede pulsar', () => {
    render(
      <Button variant="primary" disabled>
        Pagar Bs. 1.250,00
      </Button>
    );
    expect(screen.getByRole('button', { name: 'Pagar Bs. 1.250,00' })).toBeDisabled();
  });

  it('cargando anuncia Procesando sin cambiar el ancho reservado', () => {
    render(
      <Button variant="mint" busy>
        Pagar Bs. 1.250,00
      </Button>
    );
    const button = screen.getByRole('button', { name: /Procesando/ });
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button.className).toContain('is-busy');
    expect(button.className).toContain('btn-mint');
  });

  it('el enlace no reserva el texto de carga', () => {
    render(
      <Button href="/#api" variant="secondary">
        Leer la guía
      </Button>
    );
    expect(screen.getByRole('link', { name: 'Leer la guía' })).toHaveAttribute('href', '/#api');
    expect(screen.queryByText('Procesando')).toBeNull();
  });
});
