import { FluviaLogo } from '../brand';
import { FOOTER } from '../content';

export function Footer() {
  return (
    <footer className="footer">
      <div className="footer-brand">
        <FluviaLogo height={28} tone="white" />
        <p>Fluvia está en pruebas: Próximamente. Sin dinero real.</p>
      </div>
      {FOOTER.map((column) => (
        <nav key={column.title} aria-label={column.title}>
          <p className="eyebrow">{column.title}</p>
          <ul>
            {column.links.map((link) => (
              <li key={link.label}>
                <a href={link.href}>{link.label}</a>
              </li>
            ))}
          </ul>
        </nav>
      ))}
      <div className="footer-notes">
        <p id="legal">
          Términos, privacidad y cumplimiento están en preparación. Fluvia no es banco, adquirente
          ni custodio. Nada en esta página es una oferta de mover dinero real.
        </p>
        <p id="contacto">
          Contacto en preparación. «Hablar con el equipo», «Hablar con ventas» y «Unirme a la lista»
          llegan aquí: todavía no hay buzón ni lista de espera, y esta página no envía datos.
        </p>
        <p>
          Fuente: <a href="/licenses/manrope-OFL-1.1.txt">Manrope, SIL Open Font License 1.1</a>.
        </p>
      </div>
    </footer>
  );
}
