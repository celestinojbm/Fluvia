import type { Metadata } from 'next';
import { Footer } from '../components/footer';
import { Header } from '../components/header';
import { Pricing } from '../components/pricing';

export const metadata: Metadata = {
  title: 'Precios — Fluvia',
  description:
    'Tarifas ilustrativas de Fluvia, todavía por definir. El sandbox es gratis. Las cifras de comercio son un ejemplo, no una tarifa vigente.',
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
