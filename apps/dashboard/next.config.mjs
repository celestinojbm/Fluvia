/* global process, URL */
/** @type {import('next').NextConfig} */
const nextConfig = {
  // El dashboard consume la API de Fluvia SOLO server-side (route handlers y
  // server components) reenviando la sesión desde una cookie httpOnly; el
  // navegador jamás conoce la URL de la API ni sostiene el token de sesión.
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    const dev = process.env.NODE_ENV !== 'production';
    // Llamada del asistente por WebRTC: el navegador abre la señalización con
    // el servidor LiveKit (ws/wss) y, si falla, la valida por http(s) en el
    // mismo origen. Solo ese origen, solo si está configurado AL CONSTRUIR
    // (las cabeceras se fijan en `next build`).
    const livekit = livekitOrigins(process.env.LIVEKIT_PUBLIC_URL);
    // F6 (revisión de seguridad): CSP en el panel del operador. `connect-src 'self'`
    // acota exfiltración; Next inyecta scripts/estilos inline (hydration/RSC) y en dev
    // usa eval (HMR), de ahí 'unsafe-inline' (+ 'unsafe-eval' solo en dev). Una CSP
    // con nonce es el endurecimiento siguiente (requiere middleware + E2E de navegador).
    const csp = [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ''}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      // Notas de voz (escucha previa) y respuesta hablada del asistente: blobs locales.
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

/** `ws(s)://host[:puerto]` → ` ws(s)://host[:puerto] http(s)://host[:puerto]`; si no es válido, nada. */
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
