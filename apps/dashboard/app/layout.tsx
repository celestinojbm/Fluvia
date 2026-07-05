import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'Fluvia · Operación',
  description: 'Panel de operación de Fluvia (sandbox)',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
