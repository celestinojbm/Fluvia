import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST, sheetsWebhook } from '../app/api/contacto/route';

const WEBHOOK = 'https://script.google.com/macros/s/EXAMPLE/exec';

function request(body: unknown, extra?: { raw?: string; length?: string }) {
  const raw = extra?.raw ?? JSON.stringify(body);
  const headers = new Headers({ 'content-type': 'application/json' });
  if (extra?.length) headers.set('content-length', extra.length);
  return new Request('http://localhost/api/contacto', { method: 'POST', headers, body: raw });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('POST /api/contacto', () => {
  it('sin variable responde que el envío no está configurado y no llama al webhook', async () => {
    vi.stubEnv('LANDING_SHEETS_WEBHOOK_URL', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(request({ email: 'hola@comercio.test' }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: 'unconfigured',
      message: 'El envío no está configurado. Tu correo no se guardó.',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('una URL que no es https cuenta como no configurada', () => {
    vi.stubEnv('LANDING_SHEETS_WEBHOOK_URL', 'http://script.google.com/macros/s/EXAMPLE/exec');
    expect(sheetsWebhook()).toBeNull();
  });

  it('rechaza un correo inválido sin llamar al webhook', async () => {
    vi.stubEnv('LANDING_SHEETS_WEBHOOK_URL', WEBHOOK);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(request({ email: 'no-es-correo' }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      status: 'invalid',
      message: 'Revisa el correo e inténtalo de nuevo.',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rechaza un cuerpo más grande que el límite', async () => {
    vi.stubEnv('LANDING_SHEETS_WEBHOOK_URL', WEBHOOK);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(request(null, { raw: 'x'.repeat(2001), length: '2001' }));

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('el honeypot lleno no guarda nada', async () => {
    vi.stubEnv('LANDING_SHEETS_WEBHOOK_URL', WEBHOOK);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(
      request({ email: 'hola@comercio.test', website: 'https://spam.test' })
    );

    expect(response.status).toBe(400);
    expect((await response.json()).status).toBe('error');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('envía correo, fecha ISO y origen fluvia al webhook', async () => {
    vi.stubEnv('LANDING_SHEETS_WEBHOOK_URL', WEBHOOK);
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(request({ email: '  hola@comercio.test  ', website: '   ' }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'saved',
      message: 'Listo. Guardamos tu correo.',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(WEBHOOK);
    expect(init.method).toBe('POST');
    const sent = JSON.parse(String(init.body)) as { email: string; date: string; origin: string };
    expect(sent.email).toBe('hola@comercio.test');
    expect(sent.origin).toBe('fluvia');
    expect(sent.date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Number.isNaN(Date.parse(sent.date))).toBe(false);
  });

  it('si Sheets no confirma, no dice que se guardó', async () => {
    vi.stubEnv('LANDING_SHEETS_WEBHOOK_URL', WEBHOOK);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('<html>login</html>', { status: 200 })))
    );

    const response = await POST(request({ email: 'hola@comercio.test' }));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      status: 'error',
      message: 'No pudimos guardar tu correo. Inténtalo de nuevo.',
    });
  });

  it('si el webhook falla, responde error', async () => {
    vi.stubEnv('LANDING_SHEETS_WEBHOOK_URL', WEBHOOK);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('red')))
    );

    const response = await POST(request({ email: 'hola@comercio.test' }));

    expect(response.status).toBe(502);
    expect((await response.json()).message).toBe(
      'No pudimos guardar tu correo. Inténtalo de nuevo.'
    );
  });
});
