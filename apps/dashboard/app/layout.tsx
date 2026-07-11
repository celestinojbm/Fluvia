import type { ReactNode } from 'react';
import { SandboxBadge } from './lib/sandbox-badge';
import './globals.css';

export const metadata = {
  title: 'Fluvia · Operación',
  description: 'Panel de operación de Fluvia (sandbox)',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es">
      <body>
        <SandboxBadge />
        {children}
      </body>
    </html>
  );
}
