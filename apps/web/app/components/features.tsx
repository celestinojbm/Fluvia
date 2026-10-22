import { FEATURES } from '../content';
import { Icon, type IconName } from './icons';

export function Features() {
  return (
    <section className="features" id="producto" aria-labelledby="producto-title">
      <div className="features-intro grain">
        <p className="eyebrow">03 · Funciones</p>
        <h2 id="producto-title">
          Hecho para que el dinero <span className="mark">cuadre.</span>
        </h2>
      </div>
      <ul className="feature-grid">
        {FEATURES.map((feature) => (
          <li key={feature.title} className="tile">
            <span className="ico">
              <Icon name={feature.icon as IconName} size={20} />
            </span>
            <h3>{feature.title}</h3>
            <p>{feature.body}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
