import type { Locale } from '../messages';

/**
 * Navegación común del recorrido del comercio: panel → cobrar → pagos →
 * devoluciones. Misma barra, mismo orden y misma marca de «aquí estás»
 * (`aria-current="page"`) en el POS, el justificante y las páginas de pagos y
 * devoluciones, para que ninguna pantalla del recorrido sea un callejón sin
 * salida. Server component (sin estado); en impresión se oculta (`no-print`).
 */

export type FlowSection = 'panel' | 'pos' | 'payments' | 'refunds';

const LABELS: Record<Locale, Record<FlowSection | 'aria' | 'signOut', string>> = {
  es: {
    aria: 'Recorrido del comercio',
    panel: 'Panel',
    pos: 'Cobrar',
    payments: 'Pagos',
    refunds: 'Devoluciones',
    signOut: 'Cerrar sesión',
  },
  en: {
    aria: 'Merchant flow',
    panel: 'Dashboard',
    pos: 'Charge',
    payments: 'Payments',
    refunds: 'Refunds',
    signOut: 'Sign out',
  },
};

export function flowHref(orgId: string, section: FlowSection, locale: Locale): string {
  const path =
    section === 'panel'
      ? `/o/${orgId}`
      : section === 'pos'
        ? `/o/${orgId}/pos`
        : `/o/${orgId}/${section}`;
  return locale === 'en' ? `${path}?lang=en` : path;
}

export function FlowNav({
  orgId,
  locale,
  current,
  signOutHref = '/logout',
}: {
  orgId: string;
  locale: Locale;
  /** Sección activa; `null` en páginas hijas (p. ej. un detalle). */
  current: FlowSection | null;
  signOutHref?: string;
}) {
  const t = LABELS[locale];
  const sections: FlowSection[] = ['panel', 'pos', 'payments', 'refunds'];
  return (
    <nav className="flow-nav no-print" aria-label={t.aria}>
      <ul>
        {sections.map((s) => (
          <li key={s}>
            <a
              href={flowHref(orgId, s, locale)}
              aria-current={current === s ? 'page' : undefined}
              className={s === 'pos' ? 'flow-cta' : undefined}
            >
              {t[s]}
            </a>
          </li>
        ))}
        <li className="flow-signout">
          <a href={signOutHref}>{t.signOut}</a>
        </li>
      </ul>
    </nav>
  );
}
