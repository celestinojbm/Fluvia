'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { formatAmount } from './money-format';
import {
  DISPLAY_COOKIE,
  DISPLAY_CURRENCIES,
  DISPLAY_STORAGE_KEY,
  STATUS_TEXT,
  caracasTime,
  citation,
  civilDate,
  convertDecimal,
  convertMinor,
  currencyLabel,
  formatDisplay,
  formatRate,
  isDisplayCurrency,
  parseUserAmount,
  reference,
  type Conversion,
  type DisplayCurrency,
  type FxRates,
  type FxReference,
} from './fx';

/**
 * Moneda de visualización y tasas de referencia en el navegador.
 *
 *  - La preferencia se guarda EN ESTE DISPOSITIVO (cookie para que el servidor
 *    pinte ya convertido + localStorage como respaldo). No existe un contrato
 *    de preferencias por usuario; la interfaz lo dice.
 *  - Cambiar la moneda de visualización solo recalcula equivalencias: no toca
 *    saldos, cuentas, pedidos ni importes cobrados.
 *  - Las tasas vienen del servidor (caché compartida); el navegador refresca
 *    cada minuto mientras la pestaña está visible.
 */
interface FxCtx {
  rates: FxRates | null;
  display: DisplayCurrency;
  setDisplay: (d: DisplayCurrency) => void;
  openDetail: () => void;
}

const Ctx = createContext<FxCtx>({
  rates: null,
  display: 'USD',
  setDisplay: () => undefined,
  openDetail: () => undefined,
});

export const useFx = () => useContext(Ctx);

const POLL_MS = 60_000;

export function FxProvider({
  initialRates,
  initialDisplay,
  children,
}: {
  initialRates: FxRates | null;
  initialDisplay: DisplayCurrency;
  children: ReactNode;
}) {
  const [rates, setRates] = useState(initialRates);
  const [display, setDisplayState] = useState<DisplayCurrency>(initialDisplay);
  // El detalle (y su calculadora) solo existe en el DOM mientras está abierto.
  const [detailOpen, setDetailOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);

  const persist = (d: DisplayCurrency) => {
    document.cookie = `${DISPLAY_COOKIE}=${d}; Path=/; Max-Age=31536000; SameSite=Lax`;
    try {
      window.localStorage.setItem(DISPLAY_STORAGE_KEY, d);
    } catch {
      /* sin almacenamiento local: queda la cookie */
    }
  };

  // Respaldo: si la cookie se perdió pero el dispositivo recuerda otra moneda.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(DISPLAY_STORAGE_KEY);
      if (isDisplayCurrency(saved) && saved !== initialDisplay) {
        setDisplayState(saved);
        persist(saved);
      }
    } catch {
      /* nada que recuperar */
    }
  }, [initialDisplay]);

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const res = await fetch('/api/fx/rates', { cache: 'no-store' });
        if (!res.ok) return; // se conserva lo último mostrado (con sus fechas)
        const body = (await res.json()) as FxRates;
        if (!stop && Array.isArray(body?.references)) setRates(body);
      } catch {
        /* red caída: se conserva lo último mostrado */
      }
    };
    const t = window.setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      stop = true;
      window.clearInterval(t);
      document.removeEventListener('visibilitychange', tick);
    };
  }, []);

  const setDisplay = useCallback((d: DisplayCurrency) => {
    setDisplayState(d);
    persist(d);
  }, []);

  const openDetail = useCallback(() => {
    opener.current = document.activeElement as HTMLElement | null;
    setDetailOpen(true);
  }, []);

  useEffect(() => {
    const d = dialogRef.current;
    if (!detailOpen || !d || d.open) return;
    if (typeof d.showModal === 'function') d.showModal();
    else d.setAttribute('open', ''); // entornos sin <dialog> modal (jsdom)
  }, [detailOpen]);

  const value = useMemo(
    () => ({ rates, display, setDisplay, openDetail }),
    [rates, display, setDisplay, openDetail]
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      <dialog
        ref={dialogRef}
        className="rt-dialog"
        aria-labelledby="rt-dialog-title"
        onClose={() => {
          setDetailOpen(false);
          opener.current?.focus();
        }}
        onClick={(e) => {
          // Pulsar el fondo (fuera de la caja) cierra.
          if (e.target === dialogRef.current) dialogRef.current?.close();
        }}
      >
        {detailOpen ? <RatesDetail onClose={() => dialogRef.current?.close()} /> : null}
      </dialog>
    </Ctx.Provider>
  );
}

/* ------------------------------------------------------------------------ */

function worstOf(refs: (FxReference | null)[]): 'ok' | 'test' | 'warn' {
  if (refs.some((r) => !r || r.status === 'no_disponible' || r.status === 'desactualizada'))
    return 'warn';
  if (refs.some((r) => r?.status === 'datos_de_prueba')) return 'test';
  return 'ok';
}

function stripValue(r: FxReference | null): string {
  return r?.rate ? formatRate(r.rate, 2) : 'No disponible';
}

/** Selector compartido USD · Bs · EUR · USDT (preferencia de este dispositivo). */
export function DisplaySelect({ compact = false }: { compact?: boolean }) {
  const { display, setDisplay } = useFx();
  const id = useId();
  return (
    <span className={compact ? 'rt-select rt-select-compact' : 'rt-select'}>
      <label htmlFor={id}>{compact ? 'Ver en' : 'Ver equivalencias en'}</label>
      <select
        id={id}
        value={display}
        onChange={(e) => isDisplayCurrency(e.target.value) && setDisplay(e.target.value)}
        aria-describedby={compact ? undefined : `${id}-hint`}
      >
        {DISPLAY_CURRENCIES.map((c) => (
          <option key={c} value={c}>
            {currencyLabel(c)}
          </option>
        ))}
      </select>
      {compact ? null : (
        <span id={`${id}-hint`} className="rt-hint">
          Se guarda en este dispositivo. Solo cambia cómo ves las equivalencias: tus saldos, cuentas
          y cobros siguen en su moneda original.
        </span>
      )}
    </span>
  );
}

/**
 * Franja compacta y fija bajo la barra superior: USD/Bs y EUR/Bs (BCV) y
 * USDT/Bs (referencia cruzada). Al pulsarla abre el detalle y la calculadora.
 */
export function RatesStrip() {
  const { rates, openDetail } = useFx();
  const usd = reference(rates, 'USD/VES');
  const eur = reference(rates, 'EUR/VES');
  const usdt = reference(rates, 'USDT/VES');
  const tone = worstOf([usd, eur, usdt]);
  const ref = useRef<HTMLDivElement>(null);
  // Se pega justo debajo de la barra superior fija de cada superficie (su
  // alto varía: buscador de Operaciones, textos largos): se mide en vivo.
  useEffect(() => {
    const strip = ref.current;
    const header = document.querySelector<HTMLElement>('.px-top, .fx-top, .ox-top');
    if (!strip) return;
    const place = () => {
      const cs = header ? getComputedStyle(header) : null;
      const sticky = cs && cs.display !== 'none' && cs.position === 'sticky';
      strip.style.top = `${sticky ? Math.ceil(header!.getBoundingClientRect().height) + 8 : 8}px`;
    };
    place();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(place) : null;
    if (header) ro?.observe(header);
    window.addEventListener('resize', place);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', place);
    };
  }, []);
  const label = [
    `USD/Bs BCV ${stripValue(usd)}`,
    `EUR/Bs BCV ${stripValue(eur)}`,
    `USDT/Bs referencia cruzada ${stripValue(usdt)}`,
    tone === 'test' ? 'datos de prueba' : tone === 'warn' ? 'con avisos' : '',
  ]
    .filter(Boolean)
    .join(', ');
  return (
    <div ref={ref} className="rt-strip" data-tone={tone}>
      <button
        type="button"
        className="rt-strip-btn"
        onClick={openDetail}
        aria-haspopup="dialog"
        aria-label={`Tasas de referencia: ${label}. Abrir detalle y calculadora`}
      >
        <span className="rt-strip-vals">
          <span className="rt-strip-item">
            <span className="rt-k">USD</span> <span className="rt-v">{stripValue(usd)}</span>
          </span>
          <span className="rt-strip-item">
            <span className="rt-k">EUR</span> <span className="rt-v">{stripValue(eur)}</span>
          </span>
          <span className="rt-strip-item">
            <span className="rt-k">USDT</span> <span className="rt-v">{stripValue(usdt)}</span>
          </span>
          <span className="rt-strip-unit">Bs</span>
        </span>
        {tone === 'test' ? (
          <span className="rt-flag rt-flag-test">Prueba</span>
        ) : tone === 'warn' ? (
          <span className="rt-flag rt-flag-warn">Aviso</span>
        ) : null}
      </button>
      <DisplaySelect compact />
    </div>
  );
}

/* ------------------------------------------------------------------------ */

function RefCard({ r, fallback }: { r: FxReference | undefined; fallback: string }) {
  if (!r) {
    return (
      <article className="rt-ref" data-status="no_disponible">
        <h3>{fallback}</h3>
        <p className="rt-ref-rate">No disponible</p>
      </article>
    );
  }
  return (
    <article className="rt-ref" data-status={r.status}>
      <header>
        <h3>{r.label}</h3>
        <span className={`rt-badge rt-badge-${r.status}`}>{STATUS_TEXT[r.status]}</span>
      </header>
      <p className="rt-ref-rate">
        {r.rate ? (
          <>
            {formatRate(r.rate, 4)} <span className="rt-ref-unit">{r.unit}</span>
          </>
        ) : (
          'No disponible'
        )}
      </p>
      <dl>
        <div>
          <dt>Fuente</dt>
          <dd>{r.source}</dd>
        </div>
        <div>
          <dt>Método</dt>
          <dd>{r.method}</dd>
        </div>
        {r.kind !== 'market' ? (
          <div>
            <dt>Fecha aplicable</dt>
            <dd>{r.value_date ? `Fecha Valor ${civilDate(r.value_date)}` : '—'}</dd>
          </div>
        ) : null}
        {r.source_updated_at ? (
          <div>
            <dt>Actualización de la fuente</dt>
            <dd>{caracasTime(r.source_updated_at)} (Caracas)</dd>
          </div>
        ) : null}
        {r.fetched_at ? (
          <div>
            <dt>Consultada por Fluvia</dt>
            <dd>{caracasTime(r.fetched_at)} (Caracas)</dd>
          </div>
        ) : null}
      </dl>
      {r.detail ? <p className="rt-ref-detail">{r.detail}</p> : null}
      {r.next ? (
        <p className="rt-ref-detail">
          Próxima publicación: Fecha Valor {civilDate(r.next.value_date)} ·{' '}
          {formatRate(r.next.rate, 4)}. Aún no aplica.
        </p>
      ) : null}
      {r.warning ? (
        <p className="rt-ref-warn" role="note">
          {r.warning}
        </p>
      ) : null}
    </article>
  );
}

function RatesDetail({ onClose }: { onClose: () => void }) {
  const { rates } = useFx();
  const by = (p: FxReference['pair']) => rates?.references.find((x) => x.pair === p);
  return (
    <div className="rt-detail">
      <div className="rt-detail-head">
        <h2 id="rt-dialog-title">Tasas de referencia</h2>
        <button type="button" className="rt-close" onClick={onClose}>
          Cerrar
        </button>
      </div>
      <p className="rt-lead">
        Solo informativas. Fluvia no cambia divisas ni cobra con estas tasas: cada cuenta, pedido y
        cobro conserva su moneda original. Fechas y horas en hora de Caracas.
        {rates ? ` Hoy: ${civilDate(rates.today)}.` : ''}
      </p>
      {!rates ? (
        <p className="rt-ref-warn" role="status">
          No pudimos obtener las tasas. No mostramos ningún valor estimado.
        </p>
      ) : null}
      <Calculator />
      <DisplaySelect />
      <div className="rt-refs">
        <RefCard r={by('USD/VES')} fallback="USD/Bs" />
        <RefCard r={by('EUR/VES')} fallback="EUR/Bs" />
        <RefCard r={by('USDT/USD')} fallback="USDT/USD" />
        <RefCard r={by('USDT/VES')} fallback="USDT/Bs" />
      </div>
      <p className="rt-ref-detail">
        Cotización directa USDT/Bs: no se muestra.{' '}
        {rates?.direct_usdt_ves.detail ??
          'No hay una fuente pública documentada y verificable configurada.'}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------------ */

/** Calculadora informativa USD · Bs · EUR · USDT. No ejecuta nada. */
export function Calculator() {
  const { rates, display } = useFx();
  const [raw, setRaw] = useState('100');
  const [from, setFrom] = useState<DisplayCurrency>('USD');
  const [to, setTo] = useState<DisplayCurrency>(display === 'USD' ? 'VES' : display);
  const [copied, setCopied] = useState<'idle' | 'ok' | 'error'>('idle');
  const amount = parseUserAmount(raw);
  const conv = amount ? convertDecimal(rates, amount, from, to) : null;
  const result = conv ? formatDisplay(conv.minor, to) : null;
  const id = useId();

  const swap = () => {
    setFrom(to);
    setTo(from);
    setCopied('idle');
  };
  const copy = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result);
      setCopied('ok');
    } catch {
      setCopied('error');
    }
  };

  return (
    <section className="rt-calc" aria-labelledby={`${id}-t`}>
      <h3 id={`${id}-t`}>Calculadora</h3>
      <div className="rt-calc-grid">
        <div className="rt-field rt-field-amount">
          <label htmlFor={`${id}-a`}>Importe</label>
          <input
            id={`${id}-a`}
            inputMode="decimal"
            autoComplete="off"
            value={raw}
            onChange={(e) => {
              setRaw(e.target.value);
              setCopied('idle');
            }}
            aria-invalid={raw.trim() !== '' && !amount}
            aria-describedby={`${id}-err`}
          />
        </div>
        <div className="rt-field">
          <label htmlFor={`${id}-f`}>De</label>
          <select
            id={`${id}-f`}
            value={from}
            onChange={(e) => isDisplayCurrency(e.target.value) && setFrom(e.target.value)}
          >
            {DISPLAY_CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {currencyLabel(c)}
              </option>
            ))}
          </select>
        </div>
        <button type="button" className="rt-swap" onClick={swap}>
          <span aria-hidden="true">⇄</span>
          <span className="sr-only">Invertir monedas</span>
        </button>
        <div className="rt-field">
          <label htmlFor={`${id}-to`}>A</label>
          <select
            id={`${id}-to`}
            value={to}
            onChange={(e) => isDisplayCurrency(e.target.value) && setTo(e.target.value)}
          >
            {DISPLAY_CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {currencyLabel(c)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p
        id={`${id}-err`}
        className="rt-calc-err"
        role={amount || !raw.trim() ? undefined : 'alert'}
      >
        {raw.trim() && !amount ? 'Escribe un importe válido, p. ej. 1.234,56' : ''}
      </p>
      <div className="rt-calc-out" aria-live="polite">
        <p className="rt-calc-result">
          <span className="rt-k">Resultado</span>{' '}
          <output htmlFor={`${id}-a ${id}-f ${id}-to`}>
            {result ?? (amount ? 'No disponible' : '—')}
          </output>
        </p>
        {conv ? (
          <p className="rt-calc-rate">
            Tasa usada: 1 {currencyLabel(from)} = {formatRate(conv.rate, 8)} {currencyLabel(to)}
            {conv.refs.length ? ` · ${[...new Set(conv.refs.map(citation))].join(' · ')}` : ''}
            {conv.status !== 'vigente' ? ` · ${STATUS_TEXT[conv.status]}` : ''}
          </p>
        ) : amount && from !== to ? (
          <p className="rt-calc-rate">Sin tasa utilizable para este par.</p>
        ) : null}
      </div>
      <div className="rt-calc-actions">
        <button type="button" className="rt-copy" onClick={copy} disabled={!result}>
          {copied === 'ok' ? 'Copiado' : 'Copiar resultado'}
        </button>
        {copied === 'error' ? (
          <span role="alert" className="rt-calc-err">
            No se pudo copiar.
          </span>
        ) : null}
      </div>
      <p className="rt-hint">
        Solo informativa: no ejecuta pagos, transferencias ni cambio de divisas.
      </p>
    </section>
  );
}

/* ------------------------------------------------------------------------ */

function originalText(minor: string | number | bigint, currency: string): string {
  return formatAmount(minor, currency, 'es', { code: true });
}

/** Fuente y fecha de la conversión, visibles junto al importe. */
function Cite({ conv }: { conv: Conversion }) {
  return (
    <span className="rt-cite">
      {[...new Set(conv.refs.map(citation))].join(' · ')}
      {conv.status !== 'vigente' ? ` · ${STATUS_TEXT[conv.status]}` : ''}
    </span>
  );
}

/**
 * Importe protagonista en la moneda de visualización («Equivalente estimado»)
 * con el ORIGINAL visible debajo y la fuente/fecha de la conversión a un toque.
 * Si la cuenta ya está en esa moneda, o no hay tasa, el protagonista es el
 * original (jamás un valor inventado ni cero).
 */
export function ConvertedAmount({
  minor,
  currency,
  className,
  originalLabel = 'Saldo original',
}: {
  minor: string | number | bigint;
  currency: string;
  className?: string;
  originalLabel?: string;
}) {
  const { rates, display } = useFx();
  const cls = `pm-money${className ? ` ${className}` : ''}`;
  // Misma moneda, o una sin tasa de referencia aquí (COP…): solo el original.
  if (display === currency || !isDisplayCurrency(currency)) {
    return <span className={cls}>{originalText(minor, currency)}</span>;
  }
  const conv = convertMinor(rates, minor, currency, display);
  if (!conv) {
    return (
      <span className="rt-conv">
        <span className={cls}>{originalText(minor, currency)}</span>
        <span className="rt-conv-sub">Equivalente en {currencyLabel(display)}: no disponible</span>
      </span>
    );
  }
  return (
    <span className="rt-conv" data-display={display}>
      <span className="rt-conv-tag">Equivalente estimado</span>
      <span className={cls}>{formatDisplay(conv.minor, display)}</span>
      <span className="rt-conv-sub">
        {originalLabel}: <span className="pm-money">{originalText(minor, currency)}</span>
        {' · '}
        <Cite conv={conv} />
      </span>
    </span>
  );
}

/**
 * Línea SECUNDARIA de equivalencia (productos, carrito, resúmenes): el precio
 * original sigue siendo el protagonista y el que se cobra.
 */
export function Equivalence({
  minor,
  currency,
  prefix = '≈',
  compact = false,
}: {
  minor: string | number | bigint;
  currency: string;
  prefix?: string;
  /** Tablas: solo «≈ importe» (la leyenda de la tabla explica qué es). */
  compact?: boolean;
}) {
  const { rates, display } = useFx();
  if (display === currency || !isDisplayCurrency(currency)) return null;
  const conv = convertMinor(rates, minor, currency, display);
  if (!conv) {
    return compact ? (
      <span className="rt-eq">≈ no disponible</span>
    ) : (
      <span className="rt-eq">Equivalente en {currencyLabel(display)}: no disponible</span>
    );
  }
  if (compact) {
    return (
      <span className="rt-eq">
        {prefix} <span className="pm-money">{formatDisplay(conv.minor, display)}</span>
      </span>
    );
  }
  return (
    <span className="rt-eq">
      {prefix} <span className="pm-money">{formatDisplay(conv.minor, display)}</span> · equivalente
      estimado a tasa actual · <Cite conv={conv} />
    </span>
  );
}
