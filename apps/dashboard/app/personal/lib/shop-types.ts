/** Formas públicas (snake_case) de Tiendas Fluvia. Importes: string en unidades menores. */
export interface ShopSummary {
  slug: string;
  name: string;
  category: string;
  city: string;
  area: string | null;
  summary: string | null;
  photo_ref: string | null;
  banner_ref: string | null;
  is_demo: boolean;
  pickup: boolean;
  delivery: boolean;
  currencies: string[];
  product_count: number;
  favorite: boolean;
}
export interface ShopProfile extends ShopSummary {
  delivery_terms: string | null;
  returns_policy: string | null;
  contact_email: string | null;
  contact_phone: string | null;
}
export interface ShopVariant {
  id: string;
  label: string;
  price: string;
  currency: string;
  in_stock: boolean;
}
export interface ShopProduct {
  id: string;
  shop_slug: string;
  shop_name?: string;
  name: string;
  description: string | null;
  price: string;
  currency: string;
  image_ref: string | null;
  category: string | null;
  featured: boolean;
  collection: string | null;
  in_stock: boolean;
  variants: ShopVariant[];
  sellable: boolean;
}
export type CartLineStatus = 'ok' | 'price_changed' | 'unavailable' | 'out_of_stock';
export interface CartLine {
  product_id: string;
  name: string;
  variant_label: string | null;
  image_ref: string | null;
  quantity: number;
  unit_price_seen: string;
  unit_price: string | null;
  currency: string;
  in_stock: boolean;
  status: CartLineStatus;
}
export interface CartGroup {
  shop_slug: string;
  shop_name: string;
  currency: string;
  pickup: boolean;
  delivery: boolean;
  lines: CartLine[];
  total: string;
  total_seen: string;
  ready: boolean;
}
export type ShopOutcome =
  'approved' | 'pending' | 'declined' | 'unpaid' | 'cancelled' | 'partially_refunded' | 'refunded';
export type FulfillmentStatus =
  'received' | 'preparing' | 'ready' | 'shipped' | 'delivered' | 'cancelled';
export interface ShopOrder {
  order_id: string;
  shop_slug: string | null;
  shop_name: string;
  number: number;
  created_at: string;
  currency: string;
  total: string;
  lines: Array<{
    position: number;
    product_id: string | null;
    name: string;
    unit_price: string;
    quantity: number;
    line_total: string;
    variant_label: string | null;
  }>;
  payment: {
    state:
      | 'awaiting_payment'
      | 'payment_in_progress'
      | 'paid'
      | 'partially_refunded'
      | 'refunded'
      | 'cancelled';
    intent_status: string | null;
    amount_refunded: string;
    latest_intent_status: string | null;
  };
  installments: { status: string; installments_count: number; paid_count: number } | null;
  fulfillment: 'pickup' | 'delivery';
  delivery_address: string | null;
  fulfillment_status: FulfillmentStatus;
  return_requested_at: string | null;
  return_reason: string | null;
  outcome: ShopOutcome;
}

export const CATEGORY_LABEL: Record<string, string> = {
  alimentacion: 'Alimentación',
  restaurantes: 'Restaurantes',
  moda: 'Moda',
  hogar: 'Hogar',
  tecnologia: 'Tecnología',
  salud: 'Salud',
  papeleria: 'Papelería',
  servicios: 'Servicios',
};

/** Resultado de pago legible (de la API, derivado del estado canónico). */
export const OUTCOME: Record<ShopOutcome, { label: string; tone: string; text: string }> = {
  approved: { label: 'Pagado', tone: 'ok', text: 'El pago está confirmado.' },
  pending: {
    label: 'En confirmación',
    tone: 'warn',
    text: 'El pago se está confirmando con el proveedor. No pagues de nuevo: te mostraremos el resultado aquí.',
  },
  declined: {
    label: 'Pago rechazado',
    tone: 'bad',
    text: 'El último intento fue rechazado. No se cobró nada; puedes intentarlo de nuevo.',
  },
  unpaid: {
    label: 'Pendiente de pago',
    tone: 'info',
    text: 'Tu pedido está reservado y espera el pago.',
  },
  cancelled: { label: 'Anulado', tone: 'neutral', text: 'El pedido se anuló sin cobro.' },
  partially_refunded: {
    label: 'Devolución parcial',
    tone: 'info',
    text: 'Parte del pago se devolvió.',
  },
  refunded: { label: 'Devuelto', tone: 'neutral', text: 'El pago se devolvió completo.' },
};

export const FULFILLMENT: Record<FulfillmentStatus, string> = {
  received: 'Recibido por la tienda',
  preparing: 'En preparación',
  ready: 'Listo',
  shipped: 'En camino',
  delivered: 'Entregado',
  cancelled: 'Anulado',
};
