import type { Metadata } from 'next';
import { Footer } from '../components/footer';
import { Header } from '../components/header';
import { Pricing } from '../components/pricing';

export const metadata: Metadata = {
  title: 'Precios — Fluvia',
  description: 'Fluvia cobra una comisión al comercio por venta en cuotas. Tarifa: Próximamente.',
};

export default function PreciosPage() {
  return (
    <>
      <Header />
      <main id="contenido">
        <Pricing />
      </main>
      <Footer />
    </>
  );
}
