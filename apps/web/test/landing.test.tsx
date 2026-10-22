import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import HomePage from '../app/page';
import { MotionRoot } from '../app/components/motion';

function renderHome() {
  return render(
    <MotionRoot>
      <HomePage />
    </MotionRoot>
  );
}

describe('landing Menta', () => {
  it('muestra el titular, el sandbox y el testimonio como ejemplo', () => {
    renderHome();
    expect(screen.getByRole('heading', { level: 1, name: /Pagos que/ })).toBeInTheDocument();
    expect(screen.getByText(/Sin dinero real/)).toBeInTheDocument();
    expect(screen.getByText('Testimonio de ejemplo · sustituir por uno real')).toBeInTheDocument();
    expect(screen.getByText('[Nombre del comercio piloto]')).toBeInTheDocument();
    expect(screen.getByText(/datos de ejemplo/)).toBeInTheDocument();
  });

  it('abre una pregunta del acordeón', async () => {
    const user = userEvent.setup();
    renderHome();
    const question = screen.getByRole('button', { name: /si un asiento no cuadra/i });
    expect(question).toHaveAttribute('aria-expanded', 'false');
    await user.click(question);
    expect(question).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/No se registra/)).toBeInTheDocument();
  });

  it('copia el ejemplo de la API', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    renderHome();
    await user.click(screen.getByRole('button', { name: /Copiar/ }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('flv_test_••••'));
    expect(await screen.findByText('Ejemplo copiado')).toBeInTheDocument();
  });

  it('no tiene violaciones estructurales de axe', async () => {
    const { container } = renderHome();
    const results = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});
