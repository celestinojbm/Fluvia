import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { withTenantTransaction, type Pool } from '@fluvia/db';
import type { Owner } from '@fluvia/assistant';
import type { DiningService } from '@fluvia/commerce';
import type { CheckoutSessionService } from '@fluvia/payments-core';

/**
 * Credencial del COMPRADOR para su asistente. Dos formas, ambas validadas en
 * el servidor y nunca en el cuerpo:
 *  - checkout: `x-buyer-checkout: <sessionId>` + `x-checkout-client-secret`
 *    (la misma credencial de la página alojada);
 *  - seguimiento: `x-buyer-tracking: <token privado del pedido>`.
 * El titular es un id DERIVADO del alcance (sha256 → UUID): dos compradores
 * nunca comparten conversación; la RLS de 0055 (tenant + titular) lo impone.
 * Vigencia: checkout abierto y no vencido, o completado hace < 24 h; pedido
 * activo, o cerrado/anulado hace < 24 h. Fuera de eso: sesión caducada.
 */

class NamedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
export class BuyerSessionInvalidError extends NamedError {}
export class BuyerSessionExpiredError extends NamedError {}

const GRACE_MS = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function buyerOwnerId(kind: 'checkout' | 'tracking', id: string): string {
  const h = createHash('sha256').update(`fluvia-buyer:${kind}:${id}`).digest('hex');
  // Forma de UUID v4 (variante RFC 4122) para `app.actor_id`.
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const header = (req: FastifyRequest, name: string) => {
  const v = req.headers[name];
  return typeof v === 'string' ? v.trim() : '';
};

export function buyerAuthenticator(deps: {
  appPool: Pool;
  checkout: CheckoutSessionService;
  dining: DiningService;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  return async (req: FastifyRequest): Promise<Owner> => {
    const sessionId = header(req, 'x-buyer-checkout');
    const tracking = header(req, 'x-buyer-tracking');
    if (sessionId) {
      const secret = header(req, 'x-checkout-client-secret');
      if (!UUID.test(sessionId) || !secret || secret.length > 200) {
        throw new BuyerSessionInvalidError('Invalid checkout credential');
      }
      let s;
      try {
        s = await deps.checkout.resolveForBuyer(sessionId, secret);
      } catch {
        throw new BuyerSessionInvalidError('Invalid checkout credential');
      }
      const t = now();
      const alive =
        (s.status === 'open' && s.expiresAt.getTime() > t) ||
        (s.status === 'completed' && (s.completedAt?.getTime() ?? 0) > t - GRACE_MS);
      if (!alive) throw new BuyerSessionExpiredError('Checkout session expired');
      return {
        tenantId: s.tenantId,
        ownerId: buyerOwnerId('checkout', sessionId),
        kind: 'buyer',
        surface: 'buyer',
        scope: { kind: 'checkout', id: sessionId },
      };
    }
    if (tracking) {
      const ref = await deps.dining.resolveTracking(tracking);
      if (!ref) throw new BuyerSessionInvalidError('Invalid tracking token');
      const st = await withTenantTransaction(deps.appPool, ref.tenantId, (c) =>
        c.query<{ status: string; updated_at: Date }>(
          `SELECT status, updated_at FROM dining_orders WHERE id = $1`,
          [ref.orderId]
        )
      );
      const o = st.rows[0];
      if (!o) throw new BuyerSessionInvalidError('Invalid tracking token');
      const finished = ['closed', 'cancelled', 'rejected'].includes(o.status);
      if (finished && o.updated_at.getTime() <= now() - GRACE_MS) {
        throw new BuyerSessionExpiredError('Order tracking expired');
      }
      return {
        tenantId: ref.tenantId,
        ownerId: buyerOwnerId('tracking', ref.orderId),
        kind: 'buyer',
        surface: 'buyer',
        scope: { kind: 'tracking', id: ref.orderId },
      };
    }
    throw new BuyerSessionInvalidError('Missing buyer credential');
  };
}
