/**
 * Errores de dominio del comercio. El `name` (clase) se traduce a un código
 * estable del catálogo de errores de la API (DOMAIN_ERROR_CODES); el mensaje
 * interno solo va a logs.
 */
export class CommerceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class ProductNotFoundError extends CommerceError {
  constructor() {
    super('Product not found');
  }
}

export class CategoryNotFoundError extends CommerceError {
  constructor() {
    super('Category not found');
  }
}

export class OrderNotFoundError extends CommerceError {
  constructor() {
    super('Order not found');
  }
}

export class CustomerNotVisibleError extends CommerceError {
  constructor() {
    super('Customer not found');
  }
}

/** Dos operadores editaron el mismo producto: la versión esperada ya no es la actual. */
export class ProductVersionConflictError extends CommerceError {
  constructor() {
    super('Product was modified by someone else');
  }
}

/** Nombre de categoría o SKU duplicado dentro de la organización. */
export class CatalogDuplicateError extends CommerceError {
  constructor(readonly field: 'name' | 'sku') {
    super(`Duplicate catalog ${field}`);
  }
}

/** Un producto del carrito no existe, está archivado o no está disponible. */
export class ProductUnavailableError extends CommerceError {
  constructor(readonly productId: string) {
    super(`Product ${productId} is not available for sale`);
  }
}

/** Un producto del carrito tiene otra moneda que la venta. */
export class OrderCurrencyMismatchError extends CommerceError {
  constructor() {
    super('All products in an order must share its currency');
  }
}

/**
 * El total calculado por el servidor no coincide con el que el cajero vio:
 * un precio cambió mientras se armaba el carrito. Nada se crea.
 */
export class OrderTotalMismatchError extends CommerceError {
  constructor() {
    super('Order total changed; review the cart');
  }
}

/** El total excede el rango representable. */
export class OrderAmountOutOfRangeError extends CommerceError {
  constructor() {
    super('Order total out of range');
  }
}

/** Cuotas: el pedido no admite un plan (cobro en curso/hecho, o ya hay un plan vivo). */
export class InstallmentPlanNotAllowedError extends CommerceError {
  constructor(readonly reason: 'sale_charged' | 'plan_exists' | 'no_order') {
    super(`Installment plan not allowed: ${reason}`);
  }
}

export class InstallmentPlanNotFoundError extends CommerceError {
  constructor() {
    super('Installment plan not found');
  }
}

/** Cuotas: la acción simulada no aplica al estado actual del plan o de la cuota. */
export class InstallmentInvalidStateError extends CommerceError {
  constructor() {
    super('Installment plan or installment is not in a state that allows this');
  }
}

/** El comprador no aceptó explícitamente las condiciones de demostración. */
export class InstallmentTermsNotAcceptedError extends CommerceError {
  constructor() {
    super('Installment terms must be explicitly accepted');
  }
}

/** Rechazo del trigger `fluvia_sandbox_plan_blocks_charge` (0050). */
export function isInstallmentPlanActive(err: unknown): boolean {
  const m = (err as { message?: unknown } | null)?.message;
  return typeof m === 'string' && m.startsWith('FLUVIA_INSTALLMENT_PLAN_ACTIVE');
}

/** Violación de unicidad (23505) sobre un índice concreto. */
export function isUniqueViolation(err: unknown, constraint: string): boolean {
  const e = err as { code?: unknown; constraint?: unknown } | null;
  return e?.code === '23505' && e?.constraint === constraint;
}
