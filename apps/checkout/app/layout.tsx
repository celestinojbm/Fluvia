import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'Fluvia Checkout',
  description: 'Pago alojado de Fluvia (sandbox)',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  // `lang` por defecto es (Colombia); la página lo ajusta al locale elegido.
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
