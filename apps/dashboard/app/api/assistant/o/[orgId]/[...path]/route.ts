import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { forwardAssistant } from '../../../../../lib/assistant-bff';
import { validIds } from '../../../../../lib/bff';

type Ctx = { params: Promise<{ orgId: string; path: string[] }> };

/** Asistente en Comercio: sesión del OPERADOR; la API exige `payments:read`. */
async function handle(req: Request, method: 'GET' | 'POST', ctx: Ctx) {
  const { orgId, path } = await ctx.params;
  if (!validIds(orgId)) return NextResponse.json({ error: { code: 'not_found' } }, { status: 404 });
  return forwardAssistant(
    req,
    method,
    path,
    `/v1/organizations/${orgId}/assistant`,
    (await cookies()).get('fluvia_session')?.value ?? null,
    'invalid_session'
  );
}

export const dynamic = 'force-dynamic';
export const GET = (req: Request, ctx: Ctx) => handle(req, 'GET', ctx);
export const POST = (req: Request, ctx: Ctx) => handle(req, 'POST', ctx);
