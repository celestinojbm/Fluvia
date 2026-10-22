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
    expect(
      screen.getByRole('heading', {
        level: 1,
        name: /Tú cobras completo\. Tu cliente paga en cuotas\./,
      })
    ).toBeInTheDocument();
    expect(screen.getByText('Próximamente', { selector: '.pill-soon' })).toBeInTheDocument();
    expect(
      screen.getByText(
        'Recibes el total de tu venta, menos la comisión. No es un préstamo para tu negocio.'
      )
    ).toBeInTheDocument();
    const ctas = screen.getAllByRole('button', { name: 'Avísame cuando esté lista' });
    expect(ctas.length).toBeGreaterThan(0);
    for (const cta of ctas) expect(cta).toBeDisabled();
    expect(
      screen
        .getAllByRole('link', { name: 'Cómo funciona' })
        .some((a) => a.getAttribute('href') === '#como-funciona')
    ).toBe(true);
    for (const title of ['Cobras completo', 'Sin deuda para ti', 'Tu cliente elige cuotas']) {
      expect(screen.getByRole('heading', { level: 3, name: title })).toBeInTheDocument();
    }
    expect(screen.getAllByText(/Sin dinero real/).length).toBeGreaterThan(0);
    expect(screen.getByText('Testimonio de ejemplo · sustituir por uno real')).toBeInTheDocument();
    expect(screen.getByText('[Nombre del comercio piloto]')).toBeInTheDocument();
    expect(screen.queryByText(/Crear API key/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Tu primer asiento/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Pago Móvil/)).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Cómo funciona' })).toBeInTheDocument();
    expect(screen.getByText(/datos de ejemplo/)).toBeInTheDocument();
  });

  it('no usa copy vetado por Legal', () => {
    const { container } = renderHome();
    const examples = container.querySelectorAll('[data-example]');
    for (const node of examples) {
      expect(node.textContent).toMatch(/ejemplo/i);
    }
    const clone = container.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('[data-example]').forEach((node) => node.remove());
    const text = clone.textContent ?? '';
    expect(text).not.toMatch(/\d\s*%|%\s*\d/);
    expect(text).not.toMatch(
      /(Bs\.?|USD|\$|€)\s*\d|\d[\d.,]*\s*(Bs\b|USD|bol[ií]vares|d[oó]lares)/i
    );
    for (const banned of [
      /sin inter[eé]s/i,
      /cashea/i,
      /fina presta/i,
      /socio financiero/i,
      /primer d[ií]a/i,
      /no en semanas/i,
    ]) {
      expect(text).not.toMatch(banned);
    }
  });

  it('abre una pregunta del acordeón', async () => {
    const user = userEvent.setup();
    renderHome();
    const question = screen.getByRole('button', { name: /Cuánto cuesta/i });
    expect(question).toHaveAttribute('aria-expanded', 'false');
    await user.click(question);
    expect(question).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/comisión por venta en cuotas/)).toBeInTheDocument();
  });

  it('no tiene violaciones estructurales de axe', async () => {
    const { container } = renderHome();
    const results = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(
      results.violations.map((v) => `${v.id}: ${v.help} ${v.nodes.map((n) => n.html).join(' | ')}`)
    ).toEqual([]);
  });
});
