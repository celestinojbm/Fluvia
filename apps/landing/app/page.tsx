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
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-5 py-5 md:px-8">
        <a href="#inicio" aria-label="Fluvia, inicio">
          <FluviaLogo height={28} />
        </a>
        <nav aria-label="Secciones" className="flex items-center gap-4 text-sm font-extrabold">
          <a href="#como-funciona">Cómo funciona</a>
          <a href="#escribir">Escríbenos</a>
        </nav>
      </header>

      <main id="contenido">
        <section
          id="inicio"
          className="mx-auto grid w-full max-w-6xl items-end gap-10 px-5 pt-6 pb-16 md:px-8 md:pt-10 lg:grid-cols-[minmax(0,1.15fr)_minmax(18rem,0.85fr)] lg:pb-20"
        >
          <div>
            <p className="mb-5 flex items-center gap-3 text-xs font-extrabold tracking-[0.14em] text-[var(--fl-ink-2)] uppercase">
              <FluviaSymbol size={28} />
              Para tu comercio
            </p>
            <h1 className="max-w-3xl text-[clamp(2.6rem,6vw,4.75rem)] leading-[0.95] font-extrabold tracking-[-0.04em]">
              Pagos que mueven tu negocio
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-[var(--fl-ink-2)]">
              Cobra en el mostrador, con un enlace o con un código. Quien te compra paga con su
              saldo, con su tarjeta virtual o en cuotas si tiene un límite aprobado.
            </p>
            <p className="mt-4 max-w-xl text-base leading-relaxed">
              El saldo propio, lo retenido y la garantía se ven aparte. El crédito también: no es
              saldo propio.
            </p>
          </div>
          <div
            id="escribir"
            className="rounded-3xl bg-[var(--fl-white)] p-6 shadow-[0_16px_40px_rgba(0,0,0,0.08)] md:p-8"
          >
            <h2 className="text-2xl font-extrabold tracking-[-0.03em]">Escríbenos</h2>
            <p className="mt-2 mb-6 text-[var(--fl-ink-2)]">
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
          <div className="mb-6 max-w-2xl">
            <h2 id="como-title" className="text-[clamp(1.75rem,3vw,2.25rem)] font-extrabold tracking-[-0.03em]">
              Cómo se mueve un pago
            </h2>
            <p className="mt-3 text-[var(--fl-ink-2)]">
              Una ficha sale de quien paga y llega a tu cajón. Si el recorrido no se completa, vuelve
              a la bandeja. El crédito va en otro cajón, cerrado, y no se mezcla con el saldo.
            </p>
          </div>
          <div className="mostrador-card">
            <MostradorFigure />
          </div>
        </section>

        <section aria-labelledby="orillas" className="mx-auto w-full max-w-6xl px-5 pb-20 md:px-8">
          <h2 id="orillas" className="mb-6 text-[clamp(1.75rem,3vw,2.25rem)] font-extrabold tracking-[-0.03em]">
            Las dos orillas
          </h2>
          <div className="grid gap-4 md:grid-cols-3">
            <article className="rounded-3xl bg-[var(--fl-white)] p-6">
              <h3 className="text-xl font-extrabold">Tu comercio</h3>
              <p className="mt-3 text-[var(--fl-ink-2)]">
                Cobras en el mostrador, con un enlace de pago o con un código. Publicas tu perfil
                en el directorio solo si tú lo decides.
              </p>
            </article>
            <article className="rounded-3xl bg-[var(--fl-white)] p-6">
              <h3 className="text-xl font-extrabold">Quien paga</h3>
              <p className="mt-3 text-[var(--fl-ink-2)]">
                La billetera guarda el saldo propio. Con la tarjeta virtual pagas en comercios Fluvia:
                la bloqueas y le pones límites cuando quieras.
              </p>
            </article>
            <article className="rounded-3xl border-2 border-[var(--fl-credit)] bg-[var(--fl-white)] p-6">
              <h3 className="text-xl font-extrabold text-[var(--fl-credit)]">Cuotas</h3>
              <p className="mt-3 text-[var(--fl-black)]">
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
            <FluviaLogo height={22} />
            <p className="mt-4 max-w-md text-sm text-[var(--fl-ink-2)]">
              Esta página no cobra ni mueve dinero. Fluvia, en sandbox, no opera con dinero real.
            </p>
          </div>
          <p className="text-sm">
            <a href="#escribir">Escríbenos</a>
            <span aria-hidden="true"> · </span>
            <a href="/licenses/manrope-OFL-1.1.txt">Manrope, OFL-1.1</a>
          </p>
        </div>
      </footer>
    </>
  );
}
