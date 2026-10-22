import { PLANS } from '../content';
import { Button } from './button';
import { Icon } from './icons';

export function Pricing() {
  return (
    <section className="pricing" aria-labelledby="precios-title">
      <div className="pricing-head">
        <h1 id="precios-title">
          Precios que
          <br />
          también cuadran.
        </h1>
        <p className="price-flag">Tarifas ilustrativas · por definir</p>
      </div>
      <div className="price-grid">
        {PLANS.map((plan) => (
          <article
            key={plan.id}
            className={plan.featured ? 'price-card is-featured grain' : 'price-card'}
          >
            <p className="eyebrow">{plan.kicker}</p>
            <p className="price">{plan.price}</p>
            <p className="price-detail">{plan.detail}</p>
            <ul>
              {plan.items.map((item) => (
                <li key={item}>
                  <Icon name="check" size={16} />
                  {item}
                </li>
              ))}
            </ul>
            <Button href={plan.href} variant={plan.variant}>
              {plan.cta}
            </Button>
            {plan.featured ? (
              <p className="price-placeholder">Cifra de ejemplo. No es una tarifa vigente.</p>
            ) : null}
          </article>
        ))}
      </div>
    </section>
  );
}
