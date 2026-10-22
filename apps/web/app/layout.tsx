import type { ReactNode } from 'react';
import '@fontsource-variable/manrope';
import './brand.css';
import './globals.css';
import { MotionRoot } from './components/motion';

export const metadata = {
  title: 'Fluvia — Tú cobras completo. Tu cliente paga en cuotas.',
  description:
    'Próximamente en Venezuela: recibes el total de tu venta, menos la comisión, y tu cliente paga en cuotas. En pruebas, sin dinero real.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es">
      <body>
        <a className="skip" href="#contenido">
          Saltar al contenido
        </a>
        <MotionRoot>{children}</MotionRoot>
      </body>
    </html>
  );
}
