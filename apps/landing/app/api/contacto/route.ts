/**
 * Guarda un correo en Google Sheets vía el webhook de Apps Script
 * (LANDING_SHEETS_WEBHOOK_URL). No envía correo a quien se registra y no
 * llama a ningún servicio de pago. Si la variable no está, no finge éxito.
 */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_BODY = 2000;
const MAX_EMAIL = 200;
const ORIGIN = 'fluvia';

const MESSAGE = {
  saved: 'Listo. Guardamos tu correo.',
  unconfigured: 'El envío no está configurado. Tu correo no se guardó.',
  invalid: 'Revisa el correo e inténtalo de nuevo.',
  error: 'No pudimos guardar tu correo. Inténtalo de nuevo.',
} as const;

type Status = keyof typeof MESSAGE;

function reply(status: Status, code: number) {
  return Response.json(
    { status, message: MESSAGE[status] },
    { status: code, headers: { 'cache-control': 'no-store' } }
  );
}

/** URL https del web app. Vacía, ausente o no https cuenta como no configurada. */
export function sheetsWebhook(): string | null {
  const raw = process.env.LANDING_SHEETS_WEBHOOK_URL?.trim() ?? '';
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

async function readBody(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY) return null;
  const raw = await request.text();
  if (raw.length > MAX_BODY) return null;
  return raw;
}

function fieldsOf(value: unknown): { email: string; honeypot: boolean } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const email = typeof record.email === 'string' ? record.email.trim() : '';
  const website = record.website;
  const honeypot =
    website !== undefined &&
    website !== '' &&
    (typeof website !== 'string' || website.trim() !== '');
  return { email, honeypot };
}

export async function POST(request: Request) {
  const raw = await readBody(request);
  if (raw === null) return reply('invalid', 400);

  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    return reply('invalid', 400);
  }

  const fields = fieldsOf(parsed);
  if (!fields) return reply('invalid', 400);
  if (fields.honeypot) return reply('error', 400);
  if (!EMAIL.test(fields.email) || fields.email.length > MAX_EMAIL) return reply('invalid', 400);

  const webhook = sheetsWebhook();
  if (!webhook) return reply('unconfigured', 503);

  const payload = {
    email: fields.email,
    date: new Date().toISOString(),
    origin: ORIGIN,
  };

  try {
    const response = await fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'follow',
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    if (!response.ok || !/"ok"\s*:\s*true/.test(text)) return reply('error', 502);
  } catch {
    return reply('error', 502);
  }

  return reply('saved', 200);
}
