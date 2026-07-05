/** @type {import('next').NextConfig} */
const nextConfig = {
  // El dashboard consume la API de Fluvia SOLO server-side (route handlers y
  // server components) reenviando la sesión desde una cookie httpOnly; el
  // navegador jamás conoce la URL de la API ni sostiene el token de sesión.
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
