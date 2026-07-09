import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AckButton, AdjustmentDecision, ProposeForm } from '../app/lib/case-actions';

/**
 * F4-03c-ii — comportamiento de las islas cliente de acción. Se verifica que
 * POSTean al route handler correcto con el cuerpo correcto y, sobre todo, que el
 * four-eyes (409 `four_eyes_required`) se muestra de forma inequívoca al
 * proponente. `fetch` va mockeado; `window.location.reload` va stubbeado para que
 * el recargo diferido no toque la navegación de jsdom.
 */

let fetchMock: ReturnType<typeof vi.fn>;

function respond(status: number, body: unknown) {
  const res = {
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
    clone() {
      return { json: () => Promise.resolve(body) };
    },
  };
  return Promise.resolve(res);
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

describe('AckButton', () => {
  it('POSTs to the acknowledge route handler', async () => {
    fetchMock.mockReturnValue(respond(200, { status: 'acknowledged' }));
    const user = userEvent.setup();
    render(<AckButton orgId="o1" caseId="c1" locale="es" />);
    await user.click(screen.getByRole('button', { name: 'Reconocer' }));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/orgs/o1/operational-cases/c1/acknowledge',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('shows a generic error when the action fails', async () => {
    fetchMock.mockReturnValue(respond(500, {}));
    const user = userEvent.setup();
    render(<AckButton orgId="o1" caseId="c1" locale="es" />);
    await user.click(screen.getByRole('button', { name: 'Reconocer' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo completar la acción.');
  });
});

describe('AdjustmentDecision — four-eyes', () => {
  it('shows the four-eyes message when the API rejects a self-approval (409)', async () => {
    fetchMock.mockReturnValue(respond(409, { error: { code: 'four_eyes_required' } }));
    const user = userEvent.setup();
    render(<AdjustmentDecision orgId="o1" adjustmentId="adj_1" locale="es" />);
    await user.click(screen.getByRole('button', { name: 'Aprobar' }));

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/orgs/o1/case-adjustments/adj_1/approve',
      expect.objectContaining({ method: 'POST' })
    );
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/four-eyes/);
    expect(alert).toHaveTextContent(/No puedes aprobar tu propio ajuste/);
  });

  it('rejects with a reason via the reject route handler', async () => {
    fetchMock.mockReturnValue(respond(200, { status: 'rejected' }));
    const user = userEvent.setup();
    render(<AdjustmentDecision orgId="o1" adjustmentId="adj_1" locale="es" />);
    // Abre el formulario de rechazo y envía un motivo.
    await user.click(screen.getByRole('button', { name: 'Rechazar' }));
    await user.type(screen.getByLabelText('Motivo del rechazo'), 'monto incorrecto');
    await user.click(screen.getAllByRole('button', { name: 'Rechazar' }).pop()!);

    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(url).toBe('/api/orgs/o1/case-adjustments/adj_1/reject');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      reason: 'monto incorrecto',
    });
  });
});

describe('ProposeForm', () => {
  it('POSTs amount/currency/direction/reason to the adjustments route handler', async () => {
    fetchMock.mockReturnValue(respond(201, { id: 'adj_new' }));
    const user = userEvent.setup();
    render(<ProposeForm orgId="o1" caseId="c1" locale="es" defaultAmount={9_000} />);
    await user.type(screen.getByLabelText('Motivo'), 'diferencia de liquidación');
    await user.click(screen.getByRole('button', { name: 'Proponer' }));

    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(url).toBe('/api/orgs/o1/operational-cases/c1/adjustments');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      amount: 9_000,
      currency: 'COP',
      direction: 'debit_differences',
      reason: 'diferencia de liquidación',
    });
  });

  it('does not submit when required fields are missing (no fetch)', async () => {
    const user = userEvent.setup();
    render(<ProposeForm orgId="o1" caseId="c1" locale="es" defaultAmount={null} />);
    // Sin monto ni motivo el botón está deshabilitado.
    expect(screen.getByRole('button', { name: 'Proponer' })).toBeDisabled();
    await user.type(screen.getByLabelText('Motivo'), 'x');
    // Aún sin monto → sigue deshabilitado.
    expect(screen.getByRole('button', { name: 'Proponer' })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
