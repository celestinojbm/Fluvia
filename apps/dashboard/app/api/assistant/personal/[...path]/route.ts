import { forwardAssistant } from '../../../../lib/assistant-bff';
import { personalToken } from '../../../../personal/lib/server';

type Ctx = { params: Promise<{ path: string[] }> };

/** Asistente en Personal: sesión del CLIENTE (cookie `fluvia_personal`). */
async function handle(req: Request, method: 'GET' | 'POST', ctx: Ctx) {
  return forwardAssistant(
    req,
    method,
    (await ctx.params).path,
    '/v1/personal/assistant',
    await personalToken(),
    'consumer_session_invalid'
  );
}

export const dynamic = 'force-dynamic';
export const GET = (req: Request, ctx: Ctx) => handle(req, 'GET', ctx);
export const POST = (req: Request, ctx: Ctx) => handle(req, 'POST', ctx);
