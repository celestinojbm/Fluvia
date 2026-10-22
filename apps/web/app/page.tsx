import { ApiPanel } from './components/api-panel';
import { Cta } from './components/cta';
import { Faq } from './components/faq';
import { Features } from './components/features';
import { Footer } from './components/footer';
import { Header } from './components/header';
import { Hero } from './components/hero';
import { Steps } from './components/steps';
import { Trust } from './components/trust';

export default function HomePage() {
  return (
    <>
      <Header />
      <main id="contenido">
        <Hero />
        <Steps />
        <Features />
        <ApiPanel />
        <Trust />
        <Faq />
        <Cta />
      </main>
      <Footer />
    </>
  );
}
