import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { PoolClient } from '@fluvia/db';
import { insertAuditEvent, type AuditAction } from '@fluvia/audit';
import { assertValidIdempotencyKey } from '@fluvia/idempotency';
import {
  DIRECTORY_CATEGORIES,
  PRESENTATION_IMAGE_REFS,
  SHOP_FULFILLMENT_STATUSES,
  ShopOrderStateError,
  type ShopOrderView,
  type ShopService,
} from '@fluvia/commerce';
import type { CheckoutSessionService, PaymentLinkService } from '@fluvia/payments-core';
import type { PersonalServices, ProgramActor } from '@fluvia/personal';
import type { Security } from '../security.js';
import { FixedWindowLimiter, rateLimit, type RateLimiter } from '../rate-limit.js';
import { snake } from './wire.js';

/**
 * Tiendas Fluvia — rutas HTTP.
 *
 *  - CLIENTE (`/v1/personal/shop/*`, sesión de Fluvia Personal): descubrir,
 *    favoritos, carrito, pedido, pago y seguimiento. Un pedido ajeno responde
 *    404, indistinguible de inexistente.
 *  - COMERCIO (`/v1/organizations/:orgId/shop*`, sesión del comercio):
 *    activar la tienda, publicar productos y atender pedidos en línea.
 *
 * Pago: «Pagar con Fluvia» = código de un solo uso de la tarjeta del cliente
 * por el TOTAL del pedido + confirmación del checkout del enlace de la venta,
 * en el servidor. El resultado se lee del estado DERIVADO del pedido (intents
 * del enlace): aprobado, rechazado o en confirmación. Nunca se marca pagado
 * por volver de una página.
 */

const Slug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/);
const Minor = z
  .union([
    z.string().regex(/^[0-9]{1,16}$/),
    z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  ])
  .transform((v) => BigInt(v));
const Currency = z.string().regex(/^[A-Z]{3}$/);
const IdParam = z.object({ id: z.string().uuid() });

const StoresQuery = z
  .object({
    q: z.string().trim().max(80).optional(),
    category: z.enum(DIRECTORY_CATEGORIES).optional(),
    favorites: z.enum(['1']).optional(),
  })
  .strict();
const SearchQuery = z.object({ q: z.string().trim().min(2).max(80) }).strict();
const FavoriteBody = z.object({ slug: Slug, favorite: z.boolean() }).strict();
const CartItemBody = z
  .object({ slug: Slug, product_id: z.string().uuid(), quantity: z.number().int().min(0).max(99) })
  .strict();
const OrderBody = z
  .object({
    slug: Slug,
    currency: Currency,
    expected_total: Minor,
    fulfillment: z.enum(['pickup', 'delivery']),
    delivery_address: z.string().trim().min(5).max(240).optional(),
    /** El cliente acepta compartir nombre y correo con la tienda para este pedido. */
    share_contact: z.literal(true),
  })
  .strict();
const PayBody = z
  .object({
    card_id: z.string().uuid(),
    mode: z.enum(['wallet', 'installments']),
    installments_count: z.number().int().min(1).max(24).optional(),
  })
  .strict();
const ReturnBody = z.object({ reason: z.string().trim().min(5).max(280) }).strict();

const SettingsBody = z
  .object({
    enabled: z.boolean(),
    pickup: z.boolean(),
    delivery: z.boolean(),
    delivery_terms: z.string().trim().max(400).nullable(),
    returns_policy: z.string().trim().max(600).nullable(),
    contact_email: z.string().trim().email().max(120).nullable(),
    contact_phone: z
      .string()
      .trim()
      .regex(/^\+?[0-9 ()-]{7,20}$/)
      .nullable(),
    banner_ref: z.enum(PRESENTATION_IMAGE_REFS as unknown as [string, ...string[]]).nullable(),
    expected_version: z.number().int().min(0),
  })
  .strict();
const ListingBody = z
  .object({
    visible: z.boolean(),
    featured: z.boolean(),
    collection: z.string().trim().max(40).nullable(),
    position: z.number().int().min(0).max(10_000),
  })
  .strict();
const FulfillmentBody = z.object({ status: z.enum(SHOP_FULFILLMENT_STATUSES) }).strict();
const MerchantParams = z.object({ orgId: z.string().uuid(), merchantId: z.string().uuid() });
const OrgOrderParams = z.object({ orgId: z.string().uuid(), id: z.string().uuid() });
const OrgProductParams = z.object({ orgId: z.string().uuid(), productId: z.string().uuid() });

function idemKey(req: FastifyRequest): string {
  const raw = req.headers['idempotency-key'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  assertValidIdempotencyKey(value);
  return value!;
}

/** Vista pública del pedido para el cliente (sin el enlace interno). */
function orderOut(o: ShopOrderView) {
  const { paymentLinkId: _link, ...rest } = o;
  void _link;
  return snake({ ...rest, outcome: outcomeOf(o) });
}

/**
 * Resultado de pago legible a partir del estado DERIVADO:
 *  approved · pending (en confirmación o incierto: no pagar de nuevo) ·
 *  declined (último intento rechazado, se puede reintentar) · unpaid · cancelled.
 */
export function outcomeOf(o: Pick<ShopOrderView, 'payment'>): string {
  const p = o.payment;
  if (p.state === 'paid' || p.state === 'partially_refunded' || p.state === 'refunded') {
    return p.state === 'paid' ? 'approved' : p.state;
  }
  if (p.state === 'payment_in_progress') return 'pending';
  if (p.state === 'cancelled') return 'cancelled';
  return p.latestIntentStatus === 'failed' ? 'declined' : 'unpaid';
}

export interface PersonalShopDeps {
  shops: ShopService;
  links: PaymentLinkService;
  checkout: CheckoutSessionService;
  /** Base pública del checkout alojado (`{base}/l/{enlace}`). */
  checkoutBaseUrl: string;
}

export function registerPersonalShopRoutes(
  app: FastifyInstance,
  deps: PersonalShopDeps & {
    personal: PersonalServices;
    auth: { preHandler: Array<(req: FastifyRequest) => Promise<void>> };
    who: (req: FastifyRequest) => {
      consumerId: string;
      tenantId: string;
      email?: string;
      displayName?: string;
    };
    actor: (req: FastifyRequest) => ProgramActor;
  }
): void {
  const { shops, auth, who } = deps;
  // El tenant del evento es el del COMERCIO (donde vive el pedido): se lee de
  // la sesión de base de datos de la transacción.
  const shopAudit =
    (req: FastifyRequest, action: AuditAction, reason: string) =>
    async (c: PoolClient, resourceId: string) => {
      const t = await c.query<{ t: string }>(`SELECT current_setting('app.tenant_id') AS t`);
      await insertAuditEvent(c, {
        action,
        tenantId: t.rows[0]!.t,
        context: {
          actorType: 'consumer',
          actorId: who(req).consumerId,
          authMethod: 'consumer_session',
          requestId: String(req.id),
          ip: req.ip,
          userAgent: req.headers['user-agent'],
        },
        resourceType: 'shop_order',
        resourceId,
        riskLevel: 'low',
        reason,
      });
    };

  app.get('/v1/personal/shop/stores', auth, async (req) => {
    const q = StoresQuery.parse(req.query ?? {});
    const favorites = await shops.favoriteMerchants(who(req).tenantId, who(req).consumerId);
    const data = await shops.listShops({
      ...(q.q ? { q: q.q } : {}),
      ...(q.category ? { category: q.category } : {}),
      favorites,
      onlyFavorites: q.favorites === '1',
    });
    return snake({ data });
  });

  app.get('/v1/personal/shop/stores/:slug', auth, async (req) => {
    const { slug } = z.object({ slug: Slug }).parse(req.params);
    const favorites = await shops.favoriteMerchants(who(req).tenantId, who(req).consumerId);
    return snake(await shops.shop(slug, favorites));
  });

  app.get('/v1/personal/shop/stores/:slug/products/:id', auth, async (req) => {
    const { slug, id } = z.object({ slug: Slug, id: z.string().uuid() }).parse(req.params);
    return snake(await shops.product(slug, id));
  });

  app.get('/v1/personal/shop/search', auth, async (req) => {
    const { q } = SearchQuery.parse(req.query ?? {});
    return snake({ data: await shops.searchProducts(q) });
  });

  app.post('/v1/personal/shop/favorites', auth, async (req) => {
    const b = FavoriteBody.parse(req.body);
    await shops.setFavorite(who(req).tenantId, who(req).consumerId, b.slug, b.favorite);
    return { favorite: b.favorite };
  });

  app.get('/v1/personal/shop/cart', auth, async (req) =>
    snake({ data: await shops.cart(who(req).tenantId, who(req).consumerId) })
  );

  app.post('/v1/personal/shop/cart/items', auth, async (req) => {
    const b = CartItemBody.parse(req.body);
    await shops.setCartItem(who(req).tenantId, who(req).consumerId, {
      slug: b.slug,
      productId: b.product_id,
      quantity: b.quantity,
    });
    return snake({ data: await shops.cart(who(req).tenantId, who(req).consumerId) });
  });

  app.post('/v1/personal/shop/orders', auth, async (req, reply) => {
    const key = idemKey(req);
    const b = OrderBody.parse(req.body);
    const me = who(req);
    const { order, replayed } = await shops.createOrder(
      me.tenantId,
      { id: me.consumerId, email: me.email ?? '', displayName: me.displayName ?? 'Cliente' },
      {
        slug: b.slug,
        currency: b.currency,
        expectedTotal: b.expected_total,
        fulfillment: b.fulfillment,
        deliveryAddress: b.delivery_address ?? null,
        idempotencyKey: key,
      },
      shopAudit(req, 'shop.order_created', 'shops: consumer places an online order')
    );
    return reply.code(replayed ? 200 : 201).send(orderOut(order));
  });

  app.get('/v1/personal/shop/orders', auth, async (req) => {
    const list = await shops.listOrders(who(req).tenantId, who(req).consumerId);
    return { data: list.map(orderOut) };
  });

  app.get('/v1/personal/shop/orders/:id', auth, async (req) => {
    const { id } = IdParam.parse(req.params);
    return orderOut(await shops.getOrder(who(req).tenantId, who(req).consumerId, id));
  });

  app.post('/v1/personal/shop/orders/:id/cancel', auth, async (req) => {
    const { id } = IdParam.parse(req.params);
    return orderOut(
      await shops.cancelOrder(
        who(req).tenantId,
        who(req).consumerId,
        id,
        shopAudit(req, 'shop.order_cancelled', 'shops: consumer cancels an unpaid order')
      )
    );
  });

  app.post('/v1/personal/shop/orders/:id/return', auth, async (req) => {
    const { id } = IdParam.parse(req.params);
    const b = ReturnBody.parse(req.body);
    return orderOut(
      await shops.requestReturn(
        who(req).tenantId,
        who(req).consumerId,
        id,
        b.reason,
        shopAudit(req, 'shop.return_requested', 'shops: consumer requests a return')
      )
    );
  });

  /**
   * Pagar con la tarjeta Fluvia del cliente (saldo o cuotas), dentro de la app.
   * Reintento seguro: si el pedido ya tiene un cobro en curso o cobrado, se
   * devuelve el estado vigente sin crear otro intento; el motor impide, de
   * todos modos, un segundo cobro de la venta (enlace de cobro único).
   */
  app.post('/v1/personal/shop/orders/:id/pay', auth, async (req) => {
    idemKey(req);
    const { id } = IdParam.parse(req.params);
    const b = PayBody.parse(req.body);
    const me = who(req);
    const before = await shops.getOrder(me.tenantId, me.consumerId, id);
    if (before.payment.state !== 'awaiting_payment') {
      if (before.payment.state === 'cancelled') {
        throw new ShopOrderStateError('order is cancelled');
      }
      return orderOut(before);
    }
    const code = await deps.personal.cards.createPaymentCode(
      me.tenantId,
      me.consumerId,
      {
        cardId: b.card_id,
        mode: b.mode,
        ...(b.installments_count ? { installmentsCount: b.installments_count } : {}),
        maxAmount: before.total,
      },
      deps.actor(req)
    );
    const session = await deps.links.createSessionFromLink(before.paymentLinkId);
    try {
      await deps.checkout.confirmByClientSecret(
        session.checkoutSessionId,
        session.clientSecret,
        code.code
      );
    } catch (err) {
      // Sin respuesta del proveedor: el intent queda reteniendo la venta y el
      // estado derivado lo muestra como «en confirmación» (no pagar de nuevo).
      req.log.warn({ err }, 'shop pay: confirmation did not complete');
    }
    return orderOut(await shops.getOrder(me.tenantId, me.consumerId, id));
  });

  /**
   * Pagar con otra tarjeta: el enlace PÚBLICO de la venta en el checkout
   * alojado existente (crea su sesión y su secreto en el navegador). Volver de
   * ahí no confirma nada: el estado se lee siempre del servidor.
   */
  app.post('/v1/personal/shop/orders/:id/checkout', auth, async (req) => {
    const { id } = IdParam.parse(req.params);
    const me = who(req);
    const o = await shops.getOrder(me.tenantId, me.consumerId, id);
    if (o.payment.state !== 'awaiting_payment') {
      throw new ShopOrderStateError('order is not awaiting payment');
    }
    return { url: `${deps.checkoutBaseUrl.replace(/\/$/, '')}/l/${o.paymentLinkId}` };
  });
}

export function registerShopMerchantRoutes(
  app: FastifyInstance,
  deps: { security: Security; shops: ShopService; limiter?: RateLimiter }
): void {
  const { security, shops } = deps;
  const perUser = rateLimit(deps.limiter ?? new FixedWindowLimiter(), [
    {
      keyOf: (req) =>
        req.identity && req.org
          ? `shop:user:${req.org.organizationId}:${req.identity.userId}`
          : null,
      rule: { max: 240, windowMs: 60_000 },
    },
  ]);
  const read = { preHandler: [security.session, security.org('payments:read'), perUser] };
  const write = { preHandler: [security.session, security.org('merchants:write'), perUser] };
  const tenant = (req: FastifyRequest) => req.org!.organizationId;
  const audit =
    (req: FastifyRequest, action: AuditAction, resourceType: string, reason: string) =>
    (c: PoolClient, resourceId: string) =>
      insertAuditEvent(c, {
        action,
        tenantId: tenant(req),
        context: {
          actorType: 'user',
          actorId: req.identity!.userId,
          authMethod: 'session',
          requestId: String(req.id),
          ip: req.ip,
          userAgent: req.headers['user-agent'],
        },
        resourceType,
        resourceId,
        riskLevel: action === 'shop.settings_saved' ? 'medium' : 'low',
        reason,
      });

  app.get('/v1/organizations/:orgId/shop/merchants/:merchantId', read, async (req) => {
    const { merchantId } = MerchantParams.parse(req.params);
    return snake(await shops.adminView(tenant(req), merchantId));
  });

  app.put('/v1/organizations/:orgId/shop/merchants/:merchantId', write, async (req) => {
    const { merchantId } = MerchantParams.parse(req.params);
    const b = SettingsBody.parse(req.body);
    return snake(
      await shops.upsertSettings(
        tenant(req),
        merchantId,
        {
          enabled: b.enabled,
          pickup: b.pickup,
          delivery: b.delivery,
          deliveryTerms: b.delivery_terms || null,
          returnsPolicy: b.returns_policy || null,
          contactEmail: b.contact_email || null,
          contactPhone: b.contact_phone || null,
          bannerRef: b.banner_ref,
          expectedVersion: b.expected_version,
        },
        audit(req, 'shop.settings_saved', 'shop_settings', 'shops: merchant edits its online shop')
      )
    );
  });

  app.put('/v1/organizations/:orgId/shop/listings/:productId', write, async (req) => {
    const { productId } = OrgProductParams.parse(req.params);
    const b = ListingBody.parse(req.body);
    await shops.setListing(
      tenant(req),
      productId,
      { visible: b.visible, featured: b.featured, collection: b.collection, position: b.position },
      audit(req, 'shop.listing_saved', 'catalog_product', 'shops: merchant publishes a product')
    );
    return { ok: true };
  });

  app.get('/v1/organizations/:orgId/shop/orders', read, async (req) =>
    snake({ data: await shops.adminOrders(tenant(req)) })
  );

  app.post('/v1/organizations/:orgId/shop/orders/:id/fulfillment', write, async (req) => {
    const { id } = OrgOrderParams.parse(req.params);
    const b = FulfillmentBody.parse(req.body);
    return snake(
      await shops.setFulfillment(
        tenant(req),
        id,
        b.status,
        audit(req, 'shop.fulfillment_changed', 'commerce_order', 'shops: merchant updates delivery')
      )
    );
  });
}
