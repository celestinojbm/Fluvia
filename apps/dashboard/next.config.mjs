/** @type {import('next').NextConfig} */
const nextConfig = {
  // El dashboard consume la API de Fluvia SOLO server-side (route handlers y
  // server components) reenviando la sesión desde una cookie httpOnly; el
  // navegador jamás conoce la URL de la API ni sostiene el token de sesión.
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    const dev = process.env.NODE_ENV !== 'production';
    // F6 (revisión de seguridad): CSP en el panel del operador. `connect-src 'self'`
    // acota exfiltración; Next inyecta scripts/estilos inline (hydration/RSC) y en dev
    // usa eval (HMR), de ahí 'unsafe-inline' (+ 'unsafe-eval' solo en dev). Una CSP
    // con nonce es el endurecimiento siguiente (requiere middleware + E2E de navegador).
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
