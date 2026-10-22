import type { ReactNode } from 'react';
import '@fontsource-variable/manrope';
import './brand.css';
import './globals.css';
import { MotionRoot } from './components/motion';

export const metadata = {
  title: 'Fluvia — Pagos que mueven tu negocio',
  description:
    'Infraestructura de pagos en sandbox para Venezuela. Cobra, concilia y liquida desde un libro mayor de doble partida. Sin dinero real.',
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
