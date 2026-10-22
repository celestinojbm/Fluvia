/**
 * Copy de la landing. El testimonio y las tarifas salen de los mockups y
 * están marcados como ejemplo: no son un cliente real ni una tarifa vigente
 * (el precio de producción sigue sin definirse).
 */

export const NAV = [
  { href: '/#producto', label: 'Producto' },
  { href: '/precios', label: 'Precios' },
  { href: '/#api', label: 'Documentación' },
] as const;

export const SANDBOX_HREF = '/#api';

export const LEDGER_LINES = [
  { account: '1105 Caja comercio', debit: '24.100,00', credit: '—' },
  { account: '4101 Ventas', debit: '—', credit: '23.377,00' },
  { account: '2205 Comisión Fluvia', debit: '—', credit: '723,00' },
] as const;

export const STEPS = [
  {
    n: 1,
    title: 'Cobras',
    icon: 'smartphone',
    body: 'Pago Móvil, link de pago o punto de venta: una sola API.',
    foot: 'DEBE 1105 · 1.250,00',
  },
  {
    n: 2,
    title: 'Fluvia asienta',
    icon: 'book',
    body: 'Cada evento genera partidas dobles, firmadas e inmutables.',
    foot: 'HABER 4101 · 1.212,50',
  },
  {
    n: 3,
    title: 'Liquidas',
    icon: 'landmark',
    body: 'Al banco que elijas, con la conciliación ya hecha.',
    foot: 'LIQ → Banesco · 18.000,00',
  },
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
    body: 'Formato térmico 58/80 mm desde el punto de venta.',
  },
  {
    icon: 'scale',
    title: 'Conciliación',
    body: 'Empareja banco y ledger y señala cada diferencia.',
  },
] as const;

export type SampleId = 'curl' | 'node' | 'python';

export const SAMPLES: Record<SampleId, { label: string; lines: string[] }> = {
  curl: {
    label: 'cURL',
    lines: [
      'curl https://sandbox.fluvia.dev/v1/payments \\',
      '  -H "Authorization: Bearer flv_test_••••" \\',
      '  -d amount=125000 -d currency=VES \\',
      '  -d method=pago_movil',
      '',
      '// 201 Created',
      '{',
      '  "id": "pay_8F2K", "status": "succeeded",',
      '  "ledger": { "entries": 3, "balanced": true }',
      '}',
    ],
  },
  node: {
    label: 'Node',
    lines: [
      'const res = await fetch("https://sandbox.fluvia.dev/v1/payments", {',
      '  method: "POST",',
      '  headers: { Authorization: "Bearer flv_test_••••" },',
      '  body: new URLSearchParams({',
      '    amount: "125000", currency: "VES", method: "pago_movil",',
      '  }),',
      '});',
      '// 201 Created — ejemplo, no es una llamada real',
      'const payment = await res.json();',
      'payment.ledger.balanced; // true',
    ],
  },
  python: {
    label: 'Python',
    lines: [
      'import urllib.request',
      'req = urllib.request.Request(',
      '    "https://sandbox.fluvia.dev/v1/payments",',
      '    data=b"amount=125000&currency=VES&method=pago_movil",',
      '    headers={"Authorization": "Bearer flv_test_••••"},',
      '    method="POST",',
      ')',
      '# 201 Created — ejemplo, no es una llamada real',
      '# ledger.entries == 3 and ledger.balanced is True',
    ],
  },
};

export const CONNECTORS = [
  { icon: 'smartphone', name: 'Pago Móvil', status: 'Simulado', tone: 'sim' },
  { icon: 'link', name: 'Links de pago', status: 'Listo', tone: 'ok' },
  { icon: 'store', name: 'Punto de venta', status: 'Listo', tone: 'ok' },
  { icon: 'webhook', name: 'Webhooks firmados', status: 'Listo', tone: 'ok' },
  { icon: 'landmark', name: 'Bancos nacionales', status: 'Próximo', tone: 'warn' },
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
    q: '¿Puedo mover dinero real hoy?',
    a: 'No. Fluvia está en sandbox; las credenciales live están bloqueadas hasta superar los controles de producción.',
  },
  {
    q: '¿Qué pasa si un asiento no cuadra?',
    a: 'No se registra. Cada transacción tiene que cerrar en cero: si debe y haber no suman lo mismo, el libro rechaza el asiento en lugar de dejarlo a medias.',
  },
  {
    q: '¿Qué métodos de pago soportan?',
    a: 'En sandbox: Pago Móvil simulado, links de pago y punto de venta, por una sola API. Los bancos nacionales figuran como próximo. Ninguno mueve dinero real.',
  },
  {
    q: '¿Cómo se calculan las comisiones?',
    a: 'Todavía no hay tarifa vigente. Las cifras de esta web —incluido el 1,9 % y la partida 2205 del recibo— son un ejemplo ilustrativo, marcado como tal.',
  },
  {
    q: '¿Mis datos salen de Venezuela?',
    a: 'Esta página no envía datos de comercios: no hay formulario. El ejemplo está denominado en bolívares (VES). La residencia del sandbox operativo se publicará con la documentación, cuando exista.',
  },
] as const;

export const PLANS = [
  {
    id: 'sandbox',
    kicker: 'Sandbox',
    price: 'Gratis',
    detail: 'Para integrar y probar.',
    items: ['API completa', 'Ledger y auditoría', 'Datos simulados'],
    cta: 'Empezar',
    href: '/#api',
    variant: 'secondary' as const,
    featured: false,
  },
  {
    id: 'comercio',
    kicker: 'Comercio',
    price: '1,9 %',
    detail: 'por cobro exitoso · sin mensualidad · ejemplo',
    items: ['Todo Sandbox', 'Pago Móvil y links', 'Liquidación diaria', 'Soporte por correo'],
    cta: 'Unirme a la lista',
    href: '/#contacto',
    variant: 'mint' as const,
    featured: true,
  },
  {
    id: 'plataforma',
    kicker: 'Plataforma',
    price: 'A medida',
    detail: 'Marketplaces y volumen alto.',
    items: ['Subcuentas', 'Webhooks dedicados', 'SLA y revisión de riesgo'],
    cta: 'Hablar con ventas',
    href: '/#contacto',
    variant: 'secondary' as const,
    featured: false,
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
      { href: '/#api', label: 'Documentación' },
      { href: '/#api', label: 'API' },
      { href: '/#api', label: 'Estado' },
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
