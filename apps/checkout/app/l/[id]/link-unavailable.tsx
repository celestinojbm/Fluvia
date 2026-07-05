import { MESSAGES, type Locale } from '../../messages';

/**
 * Vista de link no disponible (inexistente/deshabilitado/API caída). Presentación
 * pura (sin interactividad) reutilizando el estilo `.checkout` y el mismo mensaje
 * anti-enumeración que la vista `not_found` del checkout alojado.
 */
export function LinkUnavailable({ locale }: { locale: Locale }) {
  const t = MESSAGES[locale];
  return (
    <main className="checkout">
      <h1>{t.title}</h1>
      <p className="error" role="alert">
        {t.notFound}
      </p>
      <p className="notice">{t.sandboxNotice}</p>
    </main>
  );
}
