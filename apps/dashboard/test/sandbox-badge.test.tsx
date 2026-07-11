import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import RootLayout from '../app/layout';
import { SandboxBadge, SANDBOX_BADGE_TEXT } from '../app/lib/sandbox-badge';

/**
 * F6.5A — badge global de entorno (decisión #31): el panel opera sobre dinero
 * SIMULADO y debe declararlo sin ambigüedad en toda página. El texto es la
 * cadena literal mandatada; el root layout lo monta sobre TODO el contenido.
 */

describe('SandboxBadge (dashboard)', () => {
  it('renders exactly the mandated environment text', () => {
    render(<SandboxBadge />);
    expect(SANDBOX_BADGE_TEXT).toBe('SANDBOX — dinero simulado');
    expect(screen.getByText('SANDBOX — dinero simulado')).toBeInTheDocument();
  });

  it('is mounted by the root layout above every page', () => {
    render(
      <RootLayout>
        <p>contenido de la página</p>
      </RootLayout>
    );
    expect(screen.getByText(SANDBOX_BADGE_TEXT)).toBeInTheDocument();
    expect(screen.getByText('contenido de la página')).toBeInTheDocument();
  });
});
