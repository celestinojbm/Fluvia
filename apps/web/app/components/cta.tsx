import { SANDBOX_HREF } from '../content';
import { Button } from './button';
import { Meander } from './meander';
import { Icon } from './icons';

export function Cta() {
  return (
    <section className="cta grain" id="empezar" aria-labelledby="cta-title">
      <div>
        <p className="eyebrow">07 · Empieza</p>
        <h2 id="cta-title">
          Tu primer asiento, <span className="mint">en 5 minutos.</span>
        </h2>
      </div>
      <div className="cta-actions">
        <Button href={SANDBOX_HREF} variant="mint" icon={<Icon name="arrow" size={16} />}>
          Crear API key de prueba
        </Button>
        <Button href="/#contacto" variant="secondary" onDark className="cta-talk">
          Hablar con el equipo
        </Button>
      </div>
      <Meander tone="mint" />
    </section>
  );
}
