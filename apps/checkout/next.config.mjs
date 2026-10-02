/* global process, URL */
/** @type {import('next').NextConfig} */
const nextConfig = {
  // La página alojada consume la API de Fluvia vía route handlers server-side
  // (FLUVIA_API_URL); el navegador jamás llama a la API directamente ni conoce
  // su URL. Cabeceras de seguridad mínimas para una página de pago.
  reactStrictMode: true,
  // Asistente compartido (panel y checkout del comprador): TS/TSX de un
  // paquete del monorepo, compilado por Next.
  transpilePackages: ['@fluvia/assistant-ui'],
  poweredByHeader: false,
  async headers() {
    const dev = process.env.NODE_ENV !== 'production';
    // F6 (revisión de seguridad): CSP en la página de pago. El client_secret vive
    // en el fragmento de la URL (JS-legible); `connect-src 'self'` es el control
    // CLAVE — impide exfiltrarlo a un host ajeno si alguna vez hubiera un XSS. Next
    // inyecta scripts/estilos inline (hydration/RSC) y en dev usa eval (HMR), de ahí
    // 'unsafe-inline' (+ 'unsafe-eval' solo en dev); una CSP con nonce es el
    // endurecimiento siguiente (requiere middleware + E2E de navegador para validar).
    // Asistente del comprador: fotos y audio locales (blob:) y, SOLO si se
    // configuró al construir, el origen del servidor LiveKit propio para la
    // llamada. Ningún otro host: el secreto sigue sin poder salir.
    const livekit = livekitOrigins(process.env.LIVEKIT_PUBLIC_URL);
    const csp = [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ''}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      "font-src 'self'",
      `connect-src 'self'${livekit}`,
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "object-src 'none'",
    ].join('; ');
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'Content-Security-Policy', value: csp },
        ],
      },
    ];
  },
};

/** ws(s)://host de LiveKit → los dos orígenes que usa el cliente (ws y http). */
function livekitOrigins(raw) {
  if (!raw) return '';
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('LIVEKIT_PUBLIC_URL no es una URL válida');
  }
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:')
    throw new Error('LIVEKIT_PUBLIC_URL debe ser ws:// o wss://');
  const http = u.protocol === 'wss:' ? 'https:' : 'http:';
  return ` ${u.protocol}//${u.host} ${http}//${u.host}`;
}

export default nextConfig;
