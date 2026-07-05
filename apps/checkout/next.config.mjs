/** @type {import('next').NextConfig} */
const nextConfig = {
  // La página alojada consume la API de Fluvia vía route handlers server-side
  // (FLUVIA_API_URL); el navegador jamás llama a la API directamente ni conoce
  // su URL. Cabeceras de seguridad mínimas para una página de pago.
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ],
      },
    ];
  },
};

export default nextConfig;
