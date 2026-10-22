import { Button } from './button';
import { Meander } from './meander';

export function Cta() {
  return (
    <section className="cta grain" id="empezar" aria-labelledby="cta-title">
      <div>
        <p className="eyebrow">Próximamente</p>
        <h2 id="cta-title">
          Vende en cuotas. <span className="mint">Cobra el total de tu venta.</span>
        </h2>
        <p>Recibes el total de tu venta, menos la comisión.</p>
      </div>
      <div className="cta-actions">
        <Button variant="mint" disabled>
          Avísame cuando esté lista
        </Button>
      </div>
      <Meander tone="mint" />
    </section>
  );
}
