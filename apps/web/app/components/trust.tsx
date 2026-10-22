import { PROMISES } from '../content';
import { Icon, type IconName } from './icons';

export function Trust() {
  return (
    <section className="trust" id="confianza" aria-labelledby="confianza-title">
      <figure>
        <p className="eyebrow">05 · Confianza</p>
        <h2 className="sr-only" id="confianza-title">
          Testimonio de ejemplo
        </h2>
        <blockquote>
          <p>
            Por primera vez cerramos el día sin abrir una hoja de cálculo. El libro ya cuadra solo.
          </p>
        </blockquote>
        <figcaption>
          <span className="avatar" aria-hidden="true" />
          <span>
            <strong>[Nombre del comercio piloto]</strong>
            <span className="placeholder-note">Testimonio de ejemplo · sustituir por uno real</span>
          </span>
        </figcaption>
      </figure>
      <div className="promises">
        <p className="eyebrow">Lo que sí prometemos</p>
        <ul>
          {PROMISES.map((item) => (
            <li key={item.title}>
              <span className="ico">
                <Icon name={item.icon as IconName} size={20} />
              </span>
              <span>
                <strong>{item.title}</strong>
                <span>{item.body}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
