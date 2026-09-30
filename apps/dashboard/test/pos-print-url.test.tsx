import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { installPrintUrlGuard, PRINT_PATH } from '../app/lib/pos-print-url';
import { PosReceiptView } from '../app/lib/pos-receipt';

/**
 * Impresión del justificante: la URL del documento (con ids completos) se
 * sustituye por una sin ids mientras se imprime, para que el pie de página
 * del navegador no la muestre. Datos sintéticos.
 */

const ORG = '1bfed2e0-1de8-52d5-9352-0cfd7e27a5e1';
const PI = '57621b57-547b-4742-8f51-345696d4b3d2';
const RECEIPT_PATH = `/o/${ORG}/pos/receipts/${PI}?lang=en`;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('installPrintUrlGuard', () => {
  it('beforeprint ⇒ URL sin ids; afterprint ⇒ restaura (con query y estado)', () => {
    window.history.replaceState({ keep: 1 }, '', RECEIPT_PATH);
    const g = installPrintUrlGuard(window);
    window.dispatchEvent(new Event('beforeprint'));
    expect(window.location.pathname).toBe(PRINT_PATH);
    expect(window.location.href).not.toMatch(UUID);
    expect(window.history.state).toEqual({ keep: 1 });
    // Idempotente: un segundo beforeprint no pierde la URL original.
    window.dispatchEvent(new Event('beforeprint'));
    window.dispatchEvent(new Event('afterprint'));
    expect(`${window.location.pathname}${window.location.search}`).toBe(RECEIPT_PATH);
    expect(window.history.state).toEqual({ keep: 1 });
    g.dispose();
  });

  it('Ctrl/Cmd+P se intercepta: imprime con la URL ya sin ids; canPrint=false lo bloquea', () => {
    window.history.replaceState(null, '', RECEIPT_PATH);
    const seen: string[] = [];
    vi.stubGlobal('print', () => seen.push(window.location.href));
    let allowed = true;
    const g = installPrintUrlGuard(window, { canPrint: () => allowed });
    for (const init of [{ ctrlKey: true }, { metaKey: true }]) {
      const ev = new KeyboardEvent('keydown', { key: 'p', cancelable: true, ...init });
      window.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(true);
    }
    expect(seen).toHaveLength(2);
    for (const href of seen) expect(new URL(href).pathname).toBe(PRINT_PATH);
    expect(`${window.location.pathname}${window.location.search}`).toBe(RECEIPT_PATH);
    // Otras combinaciones no se tocan.
    const other = new KeyboardEvent('keydown', {
      key: 'p',
      ctrlKey: true,
      shiftKey: true,
      cancelable: true,
    });
    window.dispatchEvent(other);
    expect(other.defaultPrevented).toBe(false);
    // No imprimible (desactualizado): el atajo tampoco imprime.
    allowed = false;
    const blocked = new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, cancelable: true });
    window.dispatchEvent(blocked);
    expect(blocked.defaultPrevented).toBe(true);
    expect(seen).toHaveLength(2);
    g.dispose();
  });

  it('dispose restaura si la impresión quedó a medias y quita los listeners', () => {
    window.history.replaceState(null, '', RECEIPT_PATH);
    const g = installPrintUrlGuard(window);
    window.dispatchEvent(new Event('beforeprint'));
    g.dispose();
    expect(`${window.location.pathname}${window.location.search}`).toBe(RECEIPT_PATH);
    window.dispatchEvent(new Event('beforeprint'));
    expect(`${window.location.pathname}${window.location.search}`).toBe(RECEIPT_PATH);
  });
});

describe('botón «Imprimir justificante»', () => {
  it('window.print() se llama con la URL ya sin ids, y después se restaura', async () => {
    window.history.replaceState(null, '', RECEIPT_PATH);
    const body = {
      payment: {
        id: PI,
        merchant_id: 'd948f551-b02a-5154-97dc-9d9e39919cf3',
        amount: 1250,
        currency: 'USD',
        status: 'succeeded',
        amount_captured: 1250,
        amount_refunded: 0,
        created_at: '2026-09-30T14:00:00Z',
        payment_link_id: null,
      },
      merchant_name: 'Tienda Sintética',
      sale: null,
      refunds: [],
      refunds_truncated: false,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }))
    );
    let hrefDuringPrint = '';
    vi.stubGlobal(
      'print',
      vi.fn(() => {
        hrefDuringPrint = window.location.href;
      })
    );
    render(<PosReceiptView orgId={ORG} orgName={null} paymentId={PI} locale="es" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Imprimir justificante' }));
    expect(hrefDuringPrint).not.toBe('');
    expect(hrefDuringPrint).not.toMatch(UUID);
    expect(new URL(hrefDuringPrint).pathname).toBe(PRINT_PATH);
    expect(`${window.location.pathname}${window.location.search}`).toBe(RECEIPT_PATH);
    expect(screen.getByTestId('pos-receipt-print-hint')).toHaveTextContent(
      'la controla el navegador'
    );
  });
});
