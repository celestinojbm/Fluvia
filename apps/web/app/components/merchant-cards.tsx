const CARDS = [
  {
    title: 'Cobras de una vez',
    body: 'Recibes el total de tu venta, menos la comisión, en una sola liquidación.',
  },
  {
    title: 'No es un préstamo',
    body: 'No es un préstamo para tu negocio. Las condiciones sobre impagos, devoluciones y contracargos se definen en tu contrato.',
  },
  {
    title: 'Tu cliente elige cuotas',
    body: 'Tu cliente paga su compra en cuotas.',
  },
] as const;

export function MerchantCards() {
  return (
    <section id="ventajas" className="merchant-cards" aria-labelledby="ventajas-title">
      <h2 id="ventajas-title" className="sr-only">
        Ventajas para tu comercio
      </h2>
      <ul>
        {CARDS.map((card) => (
          <li key={card.title} className="merchant-card">
            <h3>{card.title}</h3>
            <p>{card.body}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
