import type { ReactNode } from 'react';
import '@fontsource-variable/manrope';
import './globals.css';

export const metadata = {
  title: 'Fluvia · Pagos que mueven tu negocio',
  description:
    'Cobra en tu comercio. Quien compra paga con su saldo, su tarjeta virtual o en cuotas si tiene un límite aprobado. El crédito no es saldo propio.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es">
      <body className="bg-[var(--fl-mint)] text-[var(--fl-black)] antialiased">{children}</body>
    </html>
  );
}
