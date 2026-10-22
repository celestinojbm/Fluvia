const CARDS = [
  {
    title: 'Cobras completo',
    body: 'Recibes el total de tu venta, menos la comisión, en una sola liquidación.',
  },
  {
    title: 'Sin deuda para ti',
    body: 'No es un préstamo para tu negocio. El riesgo de impago de tus clientes no recae en ti*.',
    note: '*Según contrato.',
  },
  {
    title: 'Tu cliente elige cuotas',
    body: 'Tu cliente paga su compra en cuotas.',
  },
] as const;

export function MerchantCards() {
  return (
    <section id="como-funciona" className="merchant-cards" aria-labelledby="como-funciona-title">
      <h2 id="como-funciona-title" className="sr-only">
        Cómo funciona
      </h2>
      <ul>
        {CARDS.map((card) => (
          <li key={card.title} className="merchant-card">
            <h3>{card.title}</h3>
            <p>{card.body}</p>
            {'note' in card ? <p className="merchant-card-note">{card.note}</p> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
