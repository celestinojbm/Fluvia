/**
 * Copy de la landing. El testimonio y las tarifas salen de los mockups y
 * están marcados como ejemplo: no son un cliente real ni una tarifa vigente
 * (el precio de producción sigue sin definirse).
 */

export const NAV = [
  { href: '/#producto', label: 'Producto' },
  { href: '/precios', label: 'Precios' },
  { href: '/#como-funciona', label: 'Cómo funciona' },
] as const;

export const SANDBOX_HREF = '/#como-funciona';

/**
 * Recibo ilustrativo del modelo: total de la venta − comisión = lo que recibe
 * el comercio. Sin importes: solo etiquetas y barras proporcionales simbólicas.
 */
export const RECEIPT_LINES = [
  { label: 'Total de la venta', sign: '', bar: 'full' },
  { label: 'Comisión al comercio', sign: '−', bar: 'fee' },
  { label: 'Recibes en una sola liquidación', sign: '=', bar: 'net' },
] as const;

export const STEPS = [
  {
    n: 1,
    title: 'Elige pagar en cuotas',
    body: 'En tu tienda o en tu link, tu cliente elige pagar en cuotas.',
  },
  {
    n: 2,
    title: 'Tú recibes el total',
    body: 'Recibes el total de la venta, menos la comisión, en una sola liquidación.',
  },
  { n: 3, title: 'Tu cliente paga sus cuotas', body: 'Las cuotas no las cobras tú.' },
] as const;

export const FEATURES = [
  {
    icon: 'book',
    title: 'Ledger de doble partida',
    body: 'Suma cero en cada transacción. Si no cuadra, no se registra.',
  },
  {
    icon: 'shield',
    title: 'RBAC y auditoría',
    body: 'Cada clic queda en la traza: quién, qué, cuándo y desde dónde.',
  },
  {
    icon: 'key',
    title: 'API keys por entorno',
    body: 'Prueba en sandbox; live queda bloqueado hasta los controles.',
  },
  {
    icon: 'refresh',
    title: 'Reembolsos parciales',
    body: 'Revierte con asientos espejo, nunca borrando.',
  },
  {
    icon: 'receipt',
    title: 'Recibos imprimibles',
    body: 'Formato térmico para impresoras del punto de venta.',
  },
  {
    icon: 'scale',
    title: 'Conciliación',
    body: 'Empareja banco y ledger y señala cada diferencia.',
  },
] as const;

export const PROMISES = [
  {
    icon: 'lock',
    title: 'Sin credenciales live',
    body: 'Bloqueadas por código hasta superar los production gates.',
  },
  {
    icon: 'scroll',
    title: 'Auditoría inmutable',
    body: 'Eventos append-only con hash encadenado.',
  },
  {
    icon: 'info',
    title: 'Lo que no somos',
    body: 'Fluvia no es banco, adquirente ni custodio.',
  },
] as const;

export const FAQ = [
  {
    q: '¿Es un préstamo para mi negocio?',
    a: 'No. Fluvia no es un crédito para tu negocio: liquida tus ventas en cuotas.',
  },
  {
    q: '¿Cuánto cuesta?',
    a: 'Una comisión por venta en cuotas que paga el comercio. Tarifa: Próximamente.',
  },
  {
    q: '¿Ya puedo usarlo?',
    a: 'Todavía no. Fluvia está en pruebas: Próximamente. No movemos dinero real.',
  },
] as const;

export const PLANS = [
  {
    id: 'comercio',
    kicker: 'Comercio',
    price: 'Próximamente',
    detail: 'Comisión al comercio por venta en cuotas. Tarifa por definir.',
    items: [
      'Recibes el total de la venta, menos la comisión',
      'Tu cliente paga en cuotas',
      'No es un préstamo para tu negocio',
    ],
    cta: 'Cómo funciona',
    href: '/#como-funciona',
    variant: 'mint' as const,
    featured: true,
  },
] as const;

export const FOOTER = [
  {
    title: 'Producto',
    links: [
      { href: '/#libro', label: 'Ledger' },
      { href: '/#producto', label: 'Links de pago' },
      { href: '/#producto', label: 'Punto de venta' },
    ],
  },
  {
    title: 'Desarrolladores',
    links: [
      { href: '/#como-funciona', label: 'Cómo funciona' },
      { href: '/#como-funciona', label: 'API' },
      { href: '/#como-funciona', label: 'Estado' },
    ],
  },
  {
    title: 'Legal',
    links: [
      { href: '/#legal', label: 'Términos' },
      { href: '/#legal', label: 'Privacidad' },
      { href: '/#legal', label: 'Cumplimiento' },
    ],
  },
  {
    title: 'Contacto',
    links: [
      { href: '/#contacto', label: 'Soporte' },
      { href: '/#contacto', label: 'Ventas' },
    ],
  },
] as const;
