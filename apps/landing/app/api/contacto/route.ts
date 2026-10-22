/**
 * PENDIENTE: no hay endpoint de recepción.
 * Valida la forma del correo y responde `pending`. No persiste, no envía,
 * no registra el correo y no llama a ningún servicio externo ni de pago.
 */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: Request) {
  const raw = await request.text();
  if (raw.length > 2000) {
    return Response.json({ status: 'invalid' }, { status: 400 });
  }

  let email = '';
  try {
    const body: unknown = raw ? JSON.parse(raw) : null;
    if (body && typeof body === 'object' && 'email' in body && typeof body.email === 'string') {
      email = body.email.trim();
    }
  } catch {
    return Response.json({ status: 'invalid' }, { status: 400 });
  }

  if (!EMAIL.test(email) || email.length > 200) {
    return Response.json({ status: 'invalid' }, { status: 400 });
  }

  return Response.json(
    { status: 'pending' },
    { status: 501, headers: { 'cache-control': 'no-store' } }
  );
}
