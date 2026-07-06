import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RespondWithEvidence } from '../app/lib/dispute-actions';

/**
 * F4-08e — isla cliente de la acción «responder con evidencia» de una disputa.
 * Se verifica que POSTea al route handler correcto (open → under_review), que
 * muestra un error genérico en fallo, y que sobre una disputa ya `under_review`
 * no re-ofrece el botón sino la confirmación (idempotencia expresada en la UI).
 * `fetch` va mockeado; `window.location.reload` va stubbeado.
 */

let fetchMock: ReturnType<typeof vi.fn>;

function respond(status: number, body: unknown = {}) {
  return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
}

beforeAll(() => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { href: 'http://localhost/', reload: vi.fn() },
  });
});

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('RespondWithEvidence', () => {
  it('POSTs to the evidence route handler when the dispute is open', async () => {
    fetchMock.mockReturnValue(respond(200, { status: 'under_review' }));
    const user = userEvent.setup();
    render(<RespondWithEvidence orgId="o1" disputeId="dp_1" status="open" locale="es" />);
    await user.click(screen.getByRole('button', { name: 'Responder con evidencia' }));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/orgs/o1/disputes/dp_1/evidence',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('shows a generic error when the action fails', async () => {
    fetchMock.mockReturnValue(respond(500));
    const user = userEvent.setup();
    render(<RespondWithEvidence orgId="o1" disputeId="dp_1" status="open" locale="es" />);
    await user.click(screen.getByRole('button', { name: 'Responder con evidencia' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo completar la acción.');
  });

  it('shows the submitted confirmation (no button) when already under_review', () => {
    render(<RespondWithEvidence orgId="o1" disputeId="dp_1" status="under_review" locale="es" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText(/Evidencia enviada/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
