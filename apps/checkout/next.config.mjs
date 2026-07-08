/** @type {import('next').NextConfig} */
const nextConfig = {
  // La página alojada consume la API de Fluvia vía route handlers server-side
  // (FLUVIA_API_URL); el navegador jamás llama a la API directamente ni conoce
  // su URL. Cabeceras de seguridad mínimas para una página de pago.
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    const dev = process.env.NODE_ENV !== 'production';
    // F6 (revisión de seguridad): CSP en la página de pago. El client_secret vive
    // en el fragmento de la URL (JS-legible); `connect-src 'self'` es el control
    // CLAVE — impide exfiltrarlo a un host ajeno si alguna vez hubiera un XSS. Next
    // inyecta scripts/estilos inline (hydration/RSC) y en dev usa eval (HMR), de ahí
    // 'unsafe-inline' (+ 'unsafe-eval' solo en dev); una CSP con nonce es el
    // endurecimiento siguiente (requiere middleware + E2E de navegador para validar).
    const csp = [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ''}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
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

export default nextConfig;
