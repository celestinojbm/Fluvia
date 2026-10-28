import { MostradorFigure } from '@/components/figures/mostrador/figure';
import { ContactForm } from '@/app/lib/contact-form';
import { FluviaLogo, FluviaSymbol } from '@/app/lib/brand';

export default function HomePage() {
  return (
    <>
      <a
        href="#contenido"
        className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-10 focus:bg-[var(--fl-black)] focus:px-3 focus:py-2 focus:text-[var(--fl-mint)]"
      >
        Saltar al contenido
      </a>
      <header className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-4 px-5 py-6 md:px-8 md:py-8">
        <a href="#inicio" aria-label="Fluvia, inicio">
          <FluviaLogo height={40} />
        </a>
        <nav
          aria-label="Secciones"
          className="flex flex-wrap items-center gap-x-6 gap-y-2 text-lg font-extrabold md:text-xl"
        >
          <a href="#como-funciona">Cómo funciona</a>
          <a href="#escribir">Escríbenos</a>
        </nav>
      </header>

      <main id="contenido">
        <section
          id="inicio"
          className="mx-auto grid w-full max-w-6xl items-start gap-8 px-5 pt-4 pb-16 md:px-8 md:pt-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(22rem,0.9fr)] lg:gap-x-12 lg:pb-24"
        >
          <p className="flex items-center gap-3 text-lg leading-snug font-extrabold tracking-[0.08em] text-[var(--fl-ink-2)] uppercase md:text-xl lg:col-span-2">
            <FluviaSymbol size={36} />
            Para tu comercio
          </p>
          <h1 className="fl-h1 lg:col-span-2">Pagos que mueven tu negocio</h1>
          <div>
            <p className="max-w-2xl text-[var(--fl-ink-2)]">
              Cobra en el mostrador, con un enlace o con un código. Quien te compra paga con su
              saldo, con su tarjeta virtual o en cuotas si tiene un límite aprobado.
            </p>
            <p className="mt-4 max-w-2xl">
              El saldo propio, lo retenido y la garantía se ven aparte. El crédito también: no es
              saldo propio.
            </p>
          </div>
          <div
            id="escribir"
            className="rounded-3xl bg-[var(--fl-white)] p-7 shadow-[0_16px_40px_rgba(0,0,0,0.08)] md:p-10"
          >
            <h2 className="fl-h2">Escríbenos</h2>
            <p className="mt-3 mb-6 text-[var(--fl-ink-2)]">
              Cuéntanos de tu comercio con tu correo.
            </p>
            <ContactForm />
          </div>
        </section>

        <section
          id="como-funciona"
          aria-labelledby="como-title"
          className="mx-auto w-full max-w-6xl px-5 pb-16 md:px-8"
        >
          <div className="mb-8 max-w-3xl">
            <h2 id="como-title" className="fl-h2">
              Cómo se mueve un pago
            </h2>
            <p className="mt-4 text-[var(--fl-ink-2)]">
              Una ficha sale de quien paga y llega a tu cajón. Si el recorrido no se completa, vuelve
              a la bandeja. El crédito va en otro cajón, cerrado, y no se mezcla con el saldo.
            </p>
          </div>
          <div className="mostrador-card">
            <MostradorFigure />
          </div>
        </section>

        <section aria-labelledby="orillas" className="mx-auto w-full max-w-6xl px-5 pb-20 md:px-8">
          <h2 id="orillas" className="fl-h2 mb-8">
            Las dos orillas
          </h2>
          <div className="grid gap-4 md:grid-cols-3">
            <article className="rounded-3xl bg-[var(--fl-white)] p-7 md:p-8">
              <h3 className="fl-h3">
                Tu comercio
              </h3>
              <p className="mt-3 text-[var(--fl-ink-2)]">
                Cobras en el mostrador, con un enlace de pago o con un código. Publicas tu perfil
                en el directorio solo si tú lo decides.
              </p>
            </article>
            <article className="rounded-3xl bg-[var(--fl-white)] p-7 md:p-8">
              <h3 className="fl-h3">
                Quien paga
              </h3>
              <p className="mt-3 text-[var(--fl-ink-2)]">
                La billetera guarda el saldo propio. Con la tarjeta virtual pagas en comercios Fluvia:
                la bloqueas y le pones límites cuando quieras.
              </p>
            </article>
            <article className="rounded-3xl border-2 border-[var(--fl-credit)] bg-[var(--fl-white)] p-7 md:p-8">
              <h3 className="fl-h3 fl-credit">
                Cuotas
              </h3>
              <p className="mt-3">
                Con un límite aprobado, una compra se divide en cuotas. El crédito no es saldo
                propio.
              </p>
            </article>
          </div>
        </section>
      </main>

      <footer className="border-t border-[var(--fl-black)]/15">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-5 py-10 md:flex-row md:items-end md:justify-between md:px-8">
          <div>
            <FluviaLogo height={32} />
            <p className="mt-4 max-w-xl text-[var(--fl-ink-2)]">
              Esta página no cobra ni mueve dinero. Fluvia, en sandbox, no opera con dinero real.
            </p>
          </div>
          <p>
            <a href="#escribir">Escríbenos</a>
            <span aria-hidden="true"> · </span>
            <a href="/licenses/manrope-OFL-1.1.txt">Manrope, OFL-1.1</a>
          </p>
        </div>
      </footer>
    </>
  );
}
