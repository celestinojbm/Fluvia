/**
 * Capacidades por MERCADO y MÉTODO: qué puede ofrecer Fluvia, dónde y con qué
 * grado de realidad.
 *
 *  - `sandbox`: implementado y demostrable en este entorno con dinero
 *    simulado. NO es una capacidad en dinero real.
 *  - `operational`: contratado y operativo con dinero real. Ninguna capacidad
 *    lo está hoy; el tipo existe para que el contrato no cambie el día que una
 *    lo esté, y solo puede declararse en este catálogo versionado (revisión de
 *    código), nunca desde una pantalla.
 *  - `pending_provider`: depende de un socio externo (banco, procesador,
 *    emisor, red) que no está conectado; no se ofrece la acción.
 *  - `not_offered`: Fluvia no la ofrece en ese mercado.
 *
 * El catálogo es el TECHO. Operaciones puede RETIRAR una capacidad de un
 * mercado (0067: freno con motivo y auditoría), nunca subirla por encima de
 * lo que dice aquí. Personal y Comercio solo ofrecen la acción cuando el
 * estado efectivo es `sandbox` u `operational`.
 */

export const MARKETS = ['VE', 'CO'] as const;
export type Market = (typeof MARKETS)[number];

export const CAPABILITY_STATUSES = [
  'sandbox',
  'operational',
  'pending_provider',
  'not_offered',
] as const;
export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];

export const CAPABILITY_KEYS = [
  'pay.wallet',
  'pay.installments',
  'pay.external_card',
  'pos.tap_to_pay',
  'pos.terminal',
  'card.virtual',
  'card.physical',
  'card.network_acceptance',
  'credit.line',
  'wallet.funding',
  'wallet.withdrawal',
  'wallet.usdt',
  'fx.reference_rates',
  'shops.connected',
] as const;
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

export interface CapabilityDefinition {
  key: CapabilityKey;
  /** Nombre para personas. */
  label: string;
  /** Qué hace falta para que funcione con dinero real (frontera externa). */
  liveDependency: string;
}

export const CAPABILITY_DEFINITIONS: Record<CapabilityKey, CapabilityDefinition> = {
  'pay.wallet': {
    key: 'pay.wallet',
    label: 'Pagar con saldo Fluvia',
    liveDependency:
      'Custodia de fondos de clientes con una entidad autorizada y licencia de dinero electrónico o pagos en el país.',
  },
  'pay.installments': {
    key: 'pay.installments',
    label: 'Pagar en cuotas Fluvia',
    liveDependency:
      'Financiador o entidad de crédito autorizada, política comercial aprobada y KYC/score reales.',
  },
  'pay.external_card': {
    key: 'pay.external_card',
    label: 'Pagar con tarjeta de otro banco',
    liveDependency: 'Procesador o adquirente certificado (PCI DSS) con contrato con el comercio.',
  },
  'pos.tap_to_pay': {
    key: 'pos.tap_to_pay',
    label: 'Tap to Pay en el teléfono del comercio',
    liveDependency:
      'Proveedor certificado de Tap to Pay (SDK del sistema operativo y del adquirente) y dispositivos compatibles.',
  },
  'pos.terminal': {
    key: 'pos.terminal',
    label: 'Datáfono físico integrado',
    liveDependency: 'Integración con el terminal de un adquirente y su certificación.',
  },
  'card.virtual': {
    key: 'card.virtual',
    label: 'Tarjeta Fluvia virtual',
    liveDependency: 'Emisor BIN sponsor y procesador de emisión; en sandbox no hay número real.',
  },
  'card.physical': {
    key: 'card.physical',
    label: 'Tarjeta Fluvia física',
    liveDependency: 'Emisor, fabricante de plásticos certificado y logística de entrega.',
  },
  'card.network_acceptance': {
    key: 'card.network_acceptance',
    label: 'Tarjeta Fluvia aceptada fuera de Fluvia',
    liveDependency: 'Membresía de red de tarjetas a través de un emisor patrocinador.',
  },
  'credit.line': {
    key: 'credit.line',
    label: 'Línea de crédito con garantía',
    liveDependency:
      'Entidad que otorgue el crédito, aprobación regulatoria y política comercial validada.',
  },
  'wallet.funding': {
    key: 'wallet.funding',
    label: 'Ingresar dinero',
    liveDependency: 'Cuenta recaudadora bancaria y conciliación con el banco.',
  },
  'wallet.withdrawal': {
    key: 'wallet.withdrawal',
    label: 'Retirar a una cuenta bancaria',
    liveDependency: 'Banco pagador con API de transferencias y conciliación.',
  },
  'wallet.usdt': {
    key: 'wallet.usdt',
    label: 'Saldo y movimientos en USDT',
    liveDependency: 'Custodio de activos digitales autorizado; Fluvia no mueve USDT.',
  },
  'fx.reference_rates': {
    key: 'fx.reference_rates',
    label: 'Tasas de referencia (solo para mostrar equivalencias)',
    liveDependency:
      'Ninguna para mostrar; convertir dinero exigiría un proveedor de cambio autorizado.',
  },
  'shops.connected': {
    key: 'shops.connected',
    label: 'Tiendas conectadas (Shopify, WooCommerce)',
    liveDependency: 'Autorización de cada comerciante (credenciales de su tienda).',
  },
};

/**
 * Techo por mercado. VE es el mercado del programa Fluvia Personal (VES/USD);
 * CO es el país inicial del núcleo de pagos (ADR PEND-001) y aquí solo tiene
 * el checkout del comercio en sandbox.
 */
export const CAPABILITY_CEILING: Record<Market, Record<CapabilityKey, CapabilityStatus>> = {
  VE: {
    'pay.wallet': 'sandbox',
    'pay.installments': 'sandbox',
    'pay.external_card': 'sandbox',
    'pos.tap_to_pay': 'sandbox',
    'pos.terminal': 'pending_provider',
    'card.virtual': 'sandbox',
    'card.physical': 'sandbox',
    'card.network_acceptance': 'pending_provider',
    'credit.line': 'sandbox',
    'wallet.funding': 'sandbox',
    'wallet.withdrawal': 'sandbox',
    'wallet.usdt': 'not_offered',
    'fx.reference_rates': 'sandbox',
    'shops.connected': 'pending_provider',
  },
  CO: {
    'pay.wallet': 'not_offered',
    'pay.installments': 'not_offered',
    'pay.external_card': 'sandbox',
    'pos.tap_to_pay': 'sandbox',
    'pos.terminal': 'pending_provider',
    'card.virtual': 'not_offered',
    'card.physical': 'not_offered',
    'card.network_acceptance': 'not_offered',
    'credit.line': 'not_offered',
    'wallet.funding': 'not_offered',
    'wallet.withdrawal': 'not_offered',
    'wallet.usdt': 'not_offered',
    'fx.reference_rates': 'not_offered',
    'shops.connected': 'pending_provider',
  },
};

/** Una capacidad se puede OFRECER (hay un botón) solo en estos estados. */
export function isOffered(status: CapabilityStatus): boolean {
  return status === 'sandbox' || status === 'operational';
}

export function isMarket(v: string): v is Market {
  return (MARKETS as readonly string[]).includes(v);
}

export function isCapabilityKey(v: string): v is CapabilityKey {
  return (CAPABILITY_KEYS as readonly string[]).includes(v);
}

export interface Withdrawal {
  market: Market;
  capability: CapabilityKey;
  reason: string;
  withdrawnAt: string;
}

export interface EffectiveCapability {
  key: CapabilityKey;
  label: string;
  market: Market;
  /** Estado efectivo (techo, o `not_offered` si Operaciones la retiró). */
  status: CapabilityStatus;
  /** Techo del catálogo (lo máximo posible hoy). */
  ceiling: CapabilityStatus;
  offered: boolean;
  /** Sandbox: dinero simulado; nunca debe presentarse como real. */
  simulated: boolean;
  liveDependency: string;
  withdrawn: { reason: string; at: string } | null;
}

/**
 * Estado efectivo = techo del catálogo, salvo retirada vigente. Un mercado
 * desconocido no ofrece nada (cerrado por defecto).
 */
export function effectiveCapability(
  market: string,
  key: CapabilityKey,
  withdrawals: readonly Withdrawal[] = []
): EffectiveCapability {
  const def = CAPABILITY_DEFINITIONS[key];
  const m = isMarket(market) ? market : null;
  const ceiling: CapabilityStatus = m ? CAPABILITY_CEILING[m][key] : 'not_offered';
  const w = m ? withdrawals.find((x) => x.market === m && x.capability === key) : undefined;
  const status: CapabilityStatus = w && isOffered(ceiling) ? 'not_offered' : ceiling;
  return {
    key,
    label: def.label,
    market: (m ?? market) as Market,
    status,
    ceiling,
    offered: isOffered(status),
    simulated: status === 'sandbox',
    liveDependency: def.liveDependency,
    withdrawn: w ? { reason: w.reason, at: w.withdrawnAt } : null,
  };
}

export function marketCapabilities(
  market: string,
  withdrawals: readonly Withdrawal[] = []
): EffectiveCapability[] {
  return CAPABILITY_KEYS.map((k) => effectiveCapability(market, k, withdrawals));
}
