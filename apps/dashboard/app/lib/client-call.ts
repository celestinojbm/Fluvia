import { CSRF_HEADER, CSRF_HEADER_VALUE } from './csrf-header';

/**
 * Llamada del navegador a un BFF propio. Distingue SIEMPRE:
 *  - ok: respuesta 2xx con su cuerpo;
 *  - http: el servidor respondió con error (con su `code` del catálogo);
 *  - network: sin respuesta (red caída / tiempo agotado) ⇒ resultado INCIERTO
 *    para una mutación: la UI no debe afirmar que falló ni que se aplicó.
 * Las mutaciones llevan el header anti-CSRF.
 */
export type CallResult<T = unknown> =
  | { kind: 'ok'; status: number; body: T }
  | { kind: 'http'; status: number; code?: string }
  | { kind: 'network' };

export async function clientCall<T = unknown>(
  url: string,
  init: { method?: 'GET' | 'POST' | 'PATCH'; body?: unknown; idempotencyKey?: string } = {}
): Promise<CallResult<T>> {
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (method !== 'GET') {
    headers['content-type'] = 'application/json';
    headers[CSRF_HEADER] = CSRF_HEADER_VALUE;
  }
  if (init.idempotencyKey) headers['idempotency-key'] = init.idempotencyKey;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: 'no-store',
    });
  } catch {
    return { kind: 'network' };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* sin JSON */
  }
  if (res.ok) return { kind: 'ok', status: res.status, body: body as T };
  const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
  return { kind: 'http', status: res.status, code: typeof code === 'string' ? code : undefined };
}

/** Mensaje para el operador según el código de error del catálogo. */
export function errorMessage(r: Exclude<CallResult, { kind: 'ok' }>): string {
  if (r.kind === 'network') {
    return 'No hubo respuesta del servidor. No sabemos si el cambio se aplicó: recarga para comprobarlo antes de repetir.';
  }
  if (r.status === 401) return 'Tu sesión caducó. Vuelve a iniciar sesión.';
  if (r.status === 403) {
    return r.code === 'origin_not_allowed'
      ? 'La petición se rechazó por seguridad (origen no confiable). Recarga la página.'
      : 'Tu rol no permite esta acción.';
  }
  switch (r.code) {
    case 'catalog_version_conflict':
      return 'Otra persona modificó este producto mientras lo editabas. Recarga para ver la versión actual.';
    case 'catalog_duplicate':
      return 'Ya existe un elemento con ese nombre o SKU.';
    case 'order_total_changed':
      return 'Un precio cambió mientras preparabas la venta. Revisa el carrito: se actualizó con los precios actuales.';
    case 'product_unavailable':
      return 'Un producto del carrito ya no está disponible. Quítalo para continuar.';
    case 'order_currency_mismatch':
      return 'Todos los productos de una venta deben tener la misma moneda.';
    case 'insufficient_stock':
      return 'No hay existencias suficientes de un producto del carrito. Las cantidades se actualizaron: revísalas.';
    case 'inventory_conflict':
      return 'La existencia no puede quedar por debajo de lo reservado por ventas abiertas.';
    case 'stock_not_tracked':
      return 'Este producto no controla existencias. Actívalo en la ficha antes de registrar entradas.';
    case 'catalog_variant_invalid':
      return 'Una variante necesita un producto base activo, con la misma moneda, y su propia etiqueta.';
    case 'order_not_cancellable':
      return 'No se puede anular: hay un cobro en curso, sin confirmar o hecho, o un plan de cuotas activo.';
    case 'order_cancelled':
      return 'Esta venta fue anulada: ya no se puede cobrar.';
    case 'idempotency_key_reuse':
      return 'Esta venta ya se registró con otro contenido. Empieza una venta nueva.';
    case 'invalid_state_transition':
      return 'La acción no aplica al estado actual. Recarga para ver el estado vigente.';
    case 'validation_error':
      return 'Revisa los datos: hay campos inválidos.';
    case 'not_found':
      return 'No se encontró (o pertenece a otra organización).';
    default:
      return r.status >= 500
        ? 'El servidor falló. No sabemos si el cambio se aplicó: recarga para comprobarlo antes de repetir.'
        : `No se pudo completar (${r.code ?? r.status}).`;
  }
}
