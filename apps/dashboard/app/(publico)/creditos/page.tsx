import { PRESENTATION_CREDITS } from '../../lib/presentation-credits';
import { PublicShell } from '../../lib/public-shell';

export const metadata = { title: 'Créditos y licencias · Fluvia' };

/** Procedencia de las fotos (CC0, verificadas en origen) y avisos de licencia. */
export default function CreditsPage() {
  return (
    <PublicShell current="/creditos">
      <div className="pb-page-head">
        <h1>Créditos y licencias</h1>
        <p>
          Las fotos de esta presentación tienen licencia CC0 1.0, comprobada en su página de origen.
          No requieren atribución; la damos igualmente.
        </p>
      </div>
      <div className="pb-panel" style={{ marginTop: 16 }}>
        <dl className="pb-facts">
          {PRESENTATION_CREDITS.map((i) => (
            <div key={i.ref}>
              <dt>{i.label}</dt>
              <dd>
                «{i.title}», {i.creator} ·{' '}
                <a href={i.sourceUrl} rel="noopener noreferrer">
                  origen
                </a>{' '}
                · CC0 1.0
              </dd>
            </div>
          ))}
        </dl>
      </div>
      <div className="pb-panel" style={{ marginTop: 16 }}>
        <h2>Tipografía e iconos</h2>
        <p>
          Manrope (SIL Open Font License 1.1, The Manrope Project Authors):{' '}
          <a href="/licenses/manrope-OFL-1.1.txt">texto de la licencia</a>. Iconos Lucide (ISC).
        </p>
      </div>
    </PublicShell>
  );
}
