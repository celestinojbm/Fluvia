import { withTenantTransaction, type Pool, type PoolClient } from '@fluvia/db';
import type { AssistantTool, ToolContext } from '@fluvia/assistant';
import type { BillService, DiningService, VenueService } from '@fluvia/commerce';
import { fmt } from './assistant-tools.js';

/**
 * Herramientas del asistente del COMPRADOR (checkout y seguimiento del
 * pedido). SOLO LECTURA y SOLO sobre el alcance que el servidor fijó al
 * validar su credencial (`owner.scope`): ningún input acepta ids, así que una
 * instrucción en el chat no puede apuntar a otro pedido, a la billetera ni a
 * datos internos del comercio. Las salidas no llevan ids internos.
 *
 * El asistente orienta y enlaza a controles reales de la página (pagar,
 * llamar al personal); no confirma pagos ni mueve dinero.
 */

const PREP: Record<string, string> = {
  draft: 'por confirmar',
  queued: 'en cola',
  accepted: 'recibido en cocina',
  preparing: 'preparándose',
  ready: 'listo',
  delivered: 'entregado',
};
const ORDER: Record<string, string> = {
  pending_acceptance: 'esperando que el personal lo confirme',
  open: 'confirmado',
  bill_requested: 'con la cuenta pedida',
  closed: 'pagado y cerrado',
  rejected: 'no aceptado por el local',
  cancelled: 'anulado',
};
const CHARGE: Record<string, string> = {
  none: 'por pagar',
  failed: 'rechazado (se puede reintentar)',
  in_progress: 'en confirmación con el proveedor (no pagues de nuevo)',
  charged: 'pagado',
};
const SESSION: Record<string, string> = {
  open: 'abierto',
  completed: 'completado',
  expired: 'vencido',
};
const INTENT: Record<string, string> = {
  succeeded: 'pagado',
  partially_refunded: 'pagado (con devolución parcial)',
  refunded: 'devuelto',
  processing: 'en confirmación con el proveedor: no pagues de nuevo',
  requires_action: 'esperando un paso del pago',
  failed: 'rechazado',
  canceled: 'cancelado',
};

export interface BuyerToolDeps {
  appPool: Pool;
  dining: DiningService;
  bills: BillService;
  venue: VenueService;
}

/** El pedido de restaurante al que apunta el alcance (si lo hay). */
async function diningOrderOf(c: PoolClient, ctx: ToolContext): Promise<string | null> {
  const scope = ctx.owner.scope;
  if (!scope) return null;
  if (scope.kind === 'tracking') return scope.id;
  const r = await c.query<{ order_id: string }>(
    `SELECT b.order_id FROM checkout_sessions cs
       JOIN payment_intents i ON i.id = cs.payment_intent_id
       JOIN dining_bill_allocations a ON a.payment_link_id = i.payment_link_id
       JOIN dining_bills b ON b.id = a.bill_id
      WHERE cs.id = $1`,
    [scope.id]
  );
  return r.rows[0]?.order_id ?? null;
}

const inTenant = <T>(d: BuyerToolDeps, ctx: ToolContext, fn: (c: PoolClient) => Promise<T>) =>
  withTenantTransaction(d.appPool, ctx.owner.tenantId, fn);

const noScope = { summary: 'No tengo un pedido o pago al que consultar.' };

export function buyerTools(d: BuyerToolDeps): AssistantTool[] {
  return [
    {
      spec: {
        name: 'get_payment_status',
        description:
          'Estado del pago del comprador: su checkout o la cuenta de SU pedido (partes, pagado, pendiente). No acepta ids.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
      actions: ['buyer.pay', 'buyer.status'],
      async run(_input, ctx) {
        const scope = ctx.owner.scope;
        if (!scope) return noScope;
        return inTenant(d, ctx, async (c) => {
          if (scope.kind === 'checkout') {
            const r = await c.query<{
              status: string;
              intent_status: string;
              amount: string;
              currency: string;
              merchant: string;
            }>(
              `SELECT cs.status, i.status AS intent_status, i.amount::text, i.currency,
                      m.name AS merchant
                 FROM checkout_sessions cs
                 JOIN payment_intents i ON i.id = cs.payment_intent_id
                 JOIN merchants m ON m.id = i.merchant_id
                WHERE cs.id = $1`,
              [scope.id]
            );
            const s = r.rows[0];
            if (!s) return noScope;
            const amount = fmt(s.amount, s.currency.trim());
            const state = INTENT[s.intent_status] ?? 'pendiente de pago';
            return {
              summary: `Pago de ${amount} a ${s.merchant}: ${state}. El checkout está ${SESSION[s.status] ?? s.status}.`,
              data: {
                amount,
                merchant: s.merchant,
                payment: state,
                checkout: SESSION[s.status] ?? s.status,
              },
            };
          }
          const billId = await c.query<{ id: string }>(
            `SELECT id FROM dining_bills WHERE order_id = $1 AND status <> 'void'`,
            [scope.id]
          );
          if (!billId.rows[0]) {
            return {
              summary:
                'Todavía no hay cuenta para tu pedido. Cuando la pidas al personal, aparecerá aquí para pagarla completa o tu parte.',
            };
          }
          const b = await d.bills.settleIn(c, ctx.owner.tenantId, billId.rows[0].id);
          const parts = b.allocations.filter((a) => !a.voided);
          const total = fmt(b.total, b.currency);
          const charged = fmt(b.charged, b.currency);
          return {
            summary:
              b.status === 'paid'
                ? `Tu cuenta de ${total} está pagada y confirmada.`
                : parts.length
                  ? `Cuenta de ${total}: pagado y confirmado ${charged}. Partes: ${parts
                      .map(
                        (p, i) =>
                          `${p.label ?? `parte ${i + 1}`} ${fmt(p.amount, b.currency)} (${CHARGE[p.charge]})`
                      )
                      .join('; ')}.`
                  : `Cuenta de ${total}: el personal aún no la habilitó para pagar.`,
            data: {
              total,
              charged,
              paid: b.status === 'paid',
              parts: parts.map((p, i) => ({
                label: p.label ?? `Parte ${i + 1}`,
                amount: fmt(p.amount, b.currency),
                state: CHARGE[p.charge],
              })),
            },
          };
        });
      },
    },
    {
      spec: {
        name: 'get_my_order',
        description:
          'Platos de SU pedido y el estado de preparación de cada uno. «Listo» no significa pagado. No acepta ids.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
      actions: ['buyer.status', 'buyer.staff'],
      async run(_input, ctx) {
        if (!ctx.owner.scope) return noScope;
        return inTenant(d, ctx, async (c) => {
          const orderId = await diningOrderOf(c, ctx);
          if (orderId) {
            const o = await d.dining.getIn(c, orderId);
            const lines = o.lines.filter((l) => !l.voided);
            return {
              summary: `Tu pedido #${o.number} está ${ORDER[o.status] ?? o.status}. ${lines
                .map((l) => `${l.quantity}× ${l.name}: ${PREP[l.prepStatus] ?? l.prepStatus}`)
                .join('; ')}.`,
              data: {
                number: o.number,
                status: ORDER[o.status] ?? o.status,
                lines: lines.map((l) => ({
                  name: l.name,
                  quantity: l.quantity,
                  prep: PREP[l.prepStatus] ?? l.prepStatus,
                })),
              },
            };
          }
          // Checkout de una venta de tienda: líneas de la venta, si existe.
          const scope = ctx.owner.scope!;
          const lines = await c.query<{ number: string; name: string; quantity: number }>(
            `SELECT o.number::text, l.name, l.quantity
               FROM checkout_sessions cs
               JOIN payment_intents i ON i.id = cs.payment_intent_id
               JOIN commerce_orders o ON o.payment_link_id = i.payment_link_id
               JOIN commerce_order_lines l ON l.order_id = o.id
              WHERE cs.id = $1 ORDER BY l.position`,
            [scope.id]
          );
          if (!lines.rows.length) {
            return { summary: 'Este pago no tiene un pedido con detalle de productos.' };
          }
          return {
            summary: `Tu compra #${lines.rows[0]!.number}: ${lines.rows
              .map((l) => `${l.quantity}× ${l.name}`)
              .join('; ')}.`,
            data: lines.rows.map((l) => ({ name: l.name, quantity: l.quantity })),
          };
        });
      },
    },
    {
      spec: {
        name: 'get_menu_info',
        description:
          'Ingredientes y alérgenos de los platos del menú de ESTE local, tal como los cargó el comercio. Si no están informados, lo dice. Nunca garantiza aptitud para alergias.',
        inputSchema: {
          type: 'object',
          properties: { q: { type: 'string', maxLength: 80 } },
          additionalProperties: false,
        },
      },
      actions: ['buyer.staff'],
      async run(input, ctx) {
        if (!ctx.owner.scope) return noScope;
        const q = typeof input.q === 'string' ? input.q.toLowerCase().slice(0, 80) : '';
        return inTenant(d, ctx, async (c) => {
          const orderId = await diningOrderOf(c, ctx);
          if (!orderId) return { summary: 'Este pago no tiene un menú de restaurante asociado.' };
          const o = await d.dining.getIn(c, orderId);
          const menu = await d.venue.menuIn(c, o.branchId);
          const words = q.split(/[^a-záéíóúñü0-9]+/i).filter((w) => w.length >= 3);
          let items = menu.filter((m) => words.some((w) => m.name.toLowerCase().includes(w)));
          // Sin plato nombrado: los de SU pedido.
          if (!items.length) {
            const mine = new Set(o.lines.map((l) => l.productId));
            items = menu.filter((m) => mine.has(m.id));
          }
          items = items.slice(0, 5);
          if (!items.length) return { summary: 'No encontré ese plato en el menú de este local.' };
          return {
            summary: `${items
              .map(
                (m) =>
                  `${m.name}: ingredientes ${m.ingredients ?? 'no informados'}; alérgenos ${
                    m.allergenInfo ?? 'no informados'
                  }`
              )
              .join(
                '. '
              )}. Es la información que cargó el comercio: si tienes una alergia, confírmalo con el personal.`,
            data: items.map((m) => ({
              name: m.name,
              ingredients: m.ingredients,
              allergens: m.allergenInfo,
              available: m.available,
            })),
          };
        });
      },
    },
  ];
}
