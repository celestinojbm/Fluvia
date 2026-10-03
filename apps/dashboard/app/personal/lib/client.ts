'use client';

import { clientCall, type CallResult } from '../../lib/client-call';

/** Clave de idempotencia nueva por intención del usuario (se reutiliza en reintentos). */
export function newKey(): string {
  return `px-${crypto.randomUUID()}`;
}

export function personalCall<T = unknown>(
  path: string,
  init: { method?: 'GET' | 'POST'; body?: unknown; idempotencyKey?: string } = {}
): Promise<CallResult<T>> {
  return clientCall<T>(`/api/personal/${path}`, init);
}

/** Mensaje claro para el cliente según el código del catálogo. */
export function personalError(r: Exclude<CallResult, { kind: 'ok' }>): string {
  if (r.kind === 'network') {
    return 'No hubo respuesta. No sabemos si la operación se hizo: revisa tus movimientos antes de repetirla.';
  }
  if (r.status === 401) return 'Tu sesión caducó. Entra de nuevo para continuar.';
  switch (r.code) {
    case 'insufficient_funds':
      return 'No tienes saldo propio suficiente para esta operación.';
    case 'credit_limit_exceeded':
      return 'El importe supera tu crédito disponible.';
    case 'collateral_committed':
      return 'Esa parte de la garantía respalda el crédito que estás usando. Paga o reduce tu deuda para liberarla.';
    case 'insufficient_collateral':
      return 'No tienes tanta garantía bloqueada.';
    case 'currency_not_supported':
      return 'Esta moneda no está disponible en tu programa.';
    case 'application_pending':
      return 'Ya tienes una solicitud en revisión. Te avisaremos cuando se decida.';
    case 'amount_exceeds_allowed':
      return 'El importe supera lo permitido para esta operación.';
    case 'invalid_state_transition':
      return 'Esta acción no aplica al estado actual. Recarga para ver el estado vigente.';
    case 'consumer_not_active':
      return 'Tu cuenta está suspendida. Escribe a soporte.';
    case 'idempotency_mismatch':
      return 'Esta operación ya se registró con otros datos. Empieza de nuevo.';
    case 'consumer_email_taken':
      return 'Ese correo ya tiene una cuenta. Entra con tu contraseña.';
    case 'invalid_credentials':
      return 'Correo o contraseña incorrectos.';
    case 'consumer_locked':
      return 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.';
    case 'validation_error':
      return 'Revisa los datos del formulario.';
    case 'not_found':
      return 'No encontramos ese elemento.';
    case 'order_total_changed':
      return 'Un precio cambió mientras revisabas. Revisa el carrito con los precios actuales.';
    case 'insufficient_stock':
      return 'Ya no hay existencias suficientes de un producto. Ajusta la cantidad.';
    case 'product_unavailable':
      return 'Un producto ya no está a la venta. Quítalo del carrito para continuar.';
    case 'order_currency_mismatch':
      return 'Los productos están en monedas distintas: se compran por separado.';
    case 'shop_cart_empty':
      return 'No hay productos de esta tienda en tu carrito.';
    case 'shop_fulfillment_unavailable':
      return 'Elige una forma de entrega que la tienda ofrezca (y escribe la dirección si es a domicilio).';
    case 'shop_order_state':
      return 'Esta acción no aplica al estado actual del pedido. Recarga para ver el estado vigente.';
    case 'origin_not_allowed':
      return 'La petición se rechazó por seguridad. Recarga la página.';
    default:
      return r.status >= 500
        ? 'El servicio falló. No sabemos si la operación se hizo: revisa tus movimientos antes de repetirla.'
        : 'No se pudo completar la operación.';
  }
}

/** Convierte un texto decimal («12,50» o «12.50») a unidades menores (string) sin coma flotante. */
export function toMinor(text: string, exponent = 2): string | null {
  const t = text.trim().replace(/\s/g, '').replace(',', '.');
  if (!/^\d{1,13}(\.\d{0,2})?$/.test(t)) return null;
  const [whole, frac = ''] = t.split('.');
  const minor =
    BigInt(whole!) * 10n ** BigInt(exponent) + BigInt((frac + '00').slice(0, exponent) || '0');
  return minor > 0n ? minor.toString() : null;
}
