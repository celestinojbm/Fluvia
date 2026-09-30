'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatAmount, type Locale } from '../messages';
import { classifySale, type SalePhase } from './pos-contract';
import { POS_MESSAGES } from './pos-messages';
import { isChargedStatus } from './pos-receipt-contract';
import { POS_RECEIPT_MESSAGES } from './pos-receipt-messages';
import { POS_REFUND_MESSAGES } from './pos-refund-messages';
import type { RecentCharge, RecentChargesResult, RecentWindow } from './pos-reads';

/**
 * Panel «Cobros recientes» del POS (cliente). Cada fila es una sesión de
 * checkout REAL con el estado de su pago. Se refresca sin recargar la página:
 * cuando el terminal observa un cambio (`refreshSignal`), al volver a la
 * pestaña y con «Actualizar».
 *
 * Los filtros (estado, comercio) se aplican SOLO a la ventana leída (la API no
 * filtra ni pagina; `limit ≤ 100`) y la UI lo dice. «Seguir» abre el cobro en
 * el terminal de esta misma pantalla; «Detalle» lleva a la página de pago.
 * No agrupa por venta: la API no relaciona link→sesiones (gap G3).
 */

const PAGE = 10;
const FOCUS_REFRESH_MS = 30_000;
const PHASES: SalePhase[] = [
  'awaiting_payment',
  'processing',
  'succeeded',
  'failed',
  'expired',
  'canceled',
  'unknown',
];

type Load = 'idle' | 'loading' | 'error' | 'auth' | 'forbidden';

function when(iso: string, locale: Locale): string {
  try {
    return new Date(iso).toLocaleString(locale === 'en' ? 'en-US' : 'es-CO', {
      dateStyle: 'short',
      timeStyle: 'short',
    });
  } catch {
    return iso;
  }
}

function timeOf(ms: number, locale: Locale): string {
  try {
    return new Date(ms).toLocaleTimeString(locale === 'en' ? 'en-US' : 'es-CO');
  } catch {
    return '';
  }
}

export function phaseOf(row: RecentCharge): SalePhase {
  return row.payment ? classifySale(row.session.status, row.payment.status) : 'unknown';
}

/** Contrato del BFF `GET /api/orgs/:orgId/pos/recent`; forma inesperada ⇒ null (error). */
export function parseRecent(v: unknown): { rows: RecentCharge[]; window: RecentWindow } | null {
  if (typeof v !== 'object' || v === null) return null;
  const { rows, window: w } = v as { rows?: unknown; window?: unknown };
  if (!Array.isArray(rows) || typeof w !== 'object' || w === null) return null;
  const { limit, returned, truncated } = w as Record<string, unknown>;
  if (typeof limit !== 'number' || typeof returned !== 'number' || typeof truncated !== 'boolean') {
    return null;
  }
  return { rows: rows as RecentCharge[], window: { limit, returned, truncated } };
}

/** Filtro puro (testeable) sobre la ventana leída. */
export function filterRecent(
  rows: RecentCharge[],
  f: { phase: SalePhase | ''; merchantId: string }
): RecentCharge[] {
  return rows.filter(
    (r) =>
      (f.phase === '' || phaseOf(r) === f.phase) &&
      (f.merchantId === '' || r.payment?.merchant_id === f.merchantId)
  );
}

export interface PosRecentChargesProps {
  orgId: string;
  locale: Locale;
  merchants: Array<{ id: string; name: string }>;
  initial: RecentChargesResult;
  /** Cambia cuando el terminal abre un cobro u observa un cambio de fase. */
  refreshSignal?: number;
  activeSessionId?: string | null;
  /** El terminal tiene una venta sin cerrar: no se puede cambiar de cobro. */
  trackLocked?: boolean;
  onTrack?: (sessionId: string) => void;
}

export function PosRecentCharges({
  orgId,
  locale,
  merchants,
  initial,
  refreshSignal = 0,
  activeSessionId = null,
  trackLocked = false,
  onTrack,
}: PosRecentChargesProps) {
  const t = POS_MESSAGES[locale];
  const tr = POS_REFUND_MESSAGES[locale];
  const trc = POS_RECEIPT_MESSAGES[locale];
  const en = locale === 'en';
  const [data, setData] = useState<{ rows: RecentCharge[]; window: RecentWindow } | null>(
    initial.ok ? { rows: initial.rows, window: initial.window } : null
  );
  const [load, setLoad] = useState<Load>(
    initial.ok
      ? 'idle'
      : initial.reason === 'auth'
        ? 'auth'
        : initial.reason === 'forbidden'
          ? 'forbidden'
          : 'error'
  );
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [phase, setPhase] = useState<SalePhase | ''>('');
  const [merchantId, setMerchantId] = useState('');
  const [visible, setVisible] = useState(PAGE);
  // Las fechas se formatean tras hidratar: el ICU del servidor y el del
  // navegador difieren (p. ej. «p. m.» vs «p.m.») y romperían la hidratación.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const seq = useRef(0);
  const lastFetch = useRef(Date.now());

  const refresh = useCallback(async () => {
    const my = ++seq.current;
    lastFetch.current = Date.now();
    setLoad('loading');
    let res: Response;
    try {
      res = await fetch(`/api/orgs/${encodeURIComponent(orgId)}/pos/recent`, {
        cache: 'no-store',
      });
    } catch {
      if (my === seq.current) setLoad('error');
      return;
    }
    if (my !== seq.current) return;
    if (res.status === 401) return setLoad('auth');
    if (res.status === 404 || res.status === 403) return setLoad('forbidden');
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* sin JSON */
    }
    if (my !== seq.current) return;
    const parsed = res.status === 200 ? parseRecent(body) : null;
    if (!parsed) return setLoad('error');
    setData(parsed);
    setFetchedAt(Date.now());
    setLoad('idle');
  }, [orgId]);

  // El terminal avisa de cambios: refresco inmediato (sin recargar la página).
  const firstSignal = useRef(refreshSignal);
  useEffect(() => {
    if (refreshSignal === firstSignal.current) return;
    void refresh();
  }, [refreshSignal, refresh]);

  // Al volver a la pestaña (p. ej. tras abrir el checkout en otra), si pasó
  // un rato: refresco acotado, sin sondeo continuo.
  useEffect(() => {
    const onVis = () => {
      if (
        document.visibilityState === 'visible' &&
        Date.now() - lastFetch.current > FOCUS_REFRESH_MS
      ) {
        void refresh();
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [refresh]);

  const names = useMemo(() => new Map(merchants.map((m) => [m.id, m.name])), [merchants]);
  const filtered = useMemo(
    () => (data ? filterRecent(data.rows, { phase, merchantId }) : []),
    [data, phase, merchantId]
  );
  const filtering = phase !== '' || merchantId !== '';
  const shown = filtered.slice(0, visible);
  // Checkouts por venta DENTRO de la ventana leída (vínculo persistente 0046).
  const perSale = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of data?.rows ?? []) {
      const l = r.payment?.payment_link_id;
      if (l) m.set(l, (m.get(l) ?? 0) + 1);
    }
    return m;
  }, [data]);
  const hasUnlinked = (data?.rows ?? []).some((r) => r.payment && !r.payment.payment_link_id);
  const blocking = load === 'auth' || load === 'forbidden';

  const lang = en ? 'lang=en&' : '';
  const trackHintId = 'pos-recent-track-locked';

  return (
    <section
      className="card pos-panel pos-recent"
      aria-labelledby="pos-recent-title"
      aria-busy={load === 'loading'}
    >
      <div className="pos-recent-head">
        <h2 id="pos-recent-title">{t.recentTitle}</h2>
        <button
          type="button"
          className="pos-refresh"
          onClick={() => void refresh()}
          disabled={load === 'loading'}
        >
          {load === 'loading' ? t.recentUpdating : t.refreshList}
        </button>
      </div>
      <p className="hint">{t.recentScope}</p>
      {hasUnlinked && (
        <p className="hint" data-testid="pos-recent-legacy">
          {t.recentUnlinkedNote}
        </p>
      )}

      {load === 'auth' && (
        <p className="error" role="alert">
          {t.recentAuthLost} <a href="/login">{t.signInAgain}</a>
        </p>
      )}
      {load === 'forbidden' && (
        <p className="error" role="alert">
          {t.recentForbidden}
        </p>
      )}
      {load === 'error' && (
        <div className="pos-alert pos-alert-bad" role="alert">
          <p>
            {data ? t.recentStale(fetchedAt ? timeOf(fetchedAt, locale) : null) : t.recentLoadError}
          </p>
          <button type="button" className="btn btn-secondary" onClick={() => void refresh()}>
            {t.retry}
          </button>
        </div>
      )}
      {!data && load === 'loading' && <p className="hint">{t.recentLoading}</p>}

      {data && !blocking && (
        <>
          <p className="hint pos-window" data-testid="pos-recent-window">
            {t.recentWindow(data.window.returned, data.window.limit, data.window.truncated)}
          </p>
          {data.rows.length === 0 ? (
            <p className="empty">{t.recentEmpty}</p>
          ) : (
            <>
              <div
                className="pos-filters"
                role="group"
                aria-label={`${t.filterStatus} · ${t.filterMerchant}`}
              >
                <div className="pos-field">
                  <label htmlFor="pos-f-phase">{t.filterStatus}</label>
                  <select
                    id="pos-f-phase"
                    value={phase}
                    onChange={(e) => {
                      setPhase(e.target.value as SalePhase | '');
                      setVisible(PAGE);
                    }}
                  >
                    <option value="">{t.filterAll}</option>
                    {PHASES.map((p) => (
                      <option key={p} value={p}>
                        {t.phase[p]}
                      </option>
                    ))}
                  </select>
                </div>
                {merchants.length > 1 && (
                  <div className="pos-field">
                    <label htmlFor="pos-f-merchant">{t.filterMerchant}</label>
                    <select
                      id="pos-f-merchant"
                      value={merchantId}
                      onChange={(e) => {
                        setMerchantId(e.target.value);
                        setVisible(PAGE);
                      }}
                    >
                      <option value="">{t.filterAll}</option>
                      {merchants.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
              <p className="hint" role="status" data-testid="pos-recent-count">
                {t.filteredCount(filtered.length, data.rows.length)}
                {fetchedAt ? ` · ${t.recentUpdatedAt(timeOf(fetchedAt, locale))}` : ''}
              </p>
              {filtered.length === 0 && (
                <div className="empty">
                  <p>{t.filteredEmpty}</p>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => {
                      setPhase('');
                      setMerchantId('');
                    }}
                  >
                    {t.clearFilters}
                  </button>
                </div>
              )}
              {trackLocked && (
                <p id={trackHintId} className="hint">
                  {t.trackLocked}
                </p>
              )}
              <ul className="pos-recent-list">
                {shown.map((row) => {
                  const { session, payment } = row;
                  const p = phaseOf(row);
                  const active = session.id === activeSessionId;
                  const label = hydrated
                    ? when(session.created_at, locale)
                    : session.created_at.slice(0, 16).replace('T', ' ');
                  const saleId = payment?.payment_link_id ?? null;
                  const href = `/o/${orgId}/pos?${lang}session=${session.id}${saleId ? `&link=${saleId}` : ''}`;
                  return (
                    <li
                      key={session.id}
                      className={`pos-recent-item${active ? ' pos-recent-active' : ''}`}
                      aria-current={active ? 'true' : undefined}
                    >
                      <div className="pos-recent-main">
                        <span className="pos-recent-amount">
                          {payment ? formatAmount(payment.amount, payment.currency, locale) : '—'}
                        </span>
                        <span className={`badge pos-phase-${p}`}>{t.phase[p]}</span>
                        {(payment?.status === 'refunded' ||
                          payment?.status === 'partially_refunded') && (
                          <span className="badge pos-refund-badge" data-testid="pos-recent-refund">
                            {payment.status === 'refunded' ? tr.badgeRefunded : tr.badgePartial}
                          </span>
                        )}
                      </div>
                      <div className="pos-recent-meta">
                        <span>{label}</span>
                        <span>
                          {payment
                            ? (names.get(payment.merchant_id) ?? t.unknownMerchant)
                            : t.paymentOutsideWindow}
                        </span>
                        <span>
                          {t.colCheckout}: <code>{session.status}</code>
                        </span>
                        {payment && (
                          <span>
                            {t.colPayment}: <code>{payment.status}</code>
                          </span>
                        )}
                        {payment && (
                          <span data-testid="pos-recent-sale">
                            {saleId ? (
                              <>
                                {t.colSale}: <code>••{saleId.slice(-4)}</code>
                                {(perSale.get(saleId) ?? 0) > 1 &&
                                  ` · ${t.saleCheckouts(perSale.get(saleId)!)}`}
                              </>
                            ) : (
                              t.saleUnlinked
                            )}
                          </span>
                        )}
                      </div>
                      <div className="pos-recent-actions">
                        {active ? (
                          <span className="pos-recent-tracking">{t.trackingNow}</span>
                        ) : trackLocked ? (
                          <button
                            type="button"
                            className="pos-link"
                            disabled
                            aria-describedby={trackHintId}
                          >
                            {t.track}
                          </button>
                        ) : (
                          <a
                            href={href}
                            aria-label={`${t.track} · ${label}`}
                            onClick={(e) => {
                              if (
                                !onTrack ||
                                e.metaKey ||
                                e.ctrlKey ||
                                e.shiftKey ||
                                e.button !== 0
                              ) {
                                return;
                              }
                              e.preventDefault();
                              onTrack(session.id);
                            }}
                          >
                            {t.track}
                          </a>
                        )}
                        {payment && isChargedStatus(payment.status) && (
                          <a
                            href={`/o/${orgId}/pos/receipts/${payment.id}${en ? '?lang=en' : ''}`}
                            aria-label={`${trc.open} · ${label}`}
                            data-testid="pos-recent-receipt"
                          >
                            {trc.open}
                          </a>
                        )}
                        {payment && (
                          <a
                            href={`/o/${orgId}/payments/${payment.id}${en ? '?lang=en' : ''}`}
                            aria-label={`${t.detail} · ${label}`}
                          >
                            {t.detail}
                          </a>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
              {filtered.length > visible && (
                <button
                  type="button"
                  className="btn btn-secondary pos-more"
                  onClick={() => setVisible((v) => v + PAGE)}
                >
                  {t.showMore(Math.min(PAGE, filtered.length - visible))}
                </button>
              )}
              {data.window.truncated && filtering && (
                <p className="hint">
                  {t.outsideWindow}{' '}
                  <a href={`/o/${orgId}/payments${en ? '?lang=en' : ''}`}>{t.goToPayments}</a>
                </p>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
