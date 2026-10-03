import type { Pool } from '@fluvia/db';
import { dec, mul, toFixed } from './decimal.js';
import type { BcvReading } from './bcv.js';
import type { UsdtReading } from './coingecko.js';

/**
 * Vista de tasas de REFERENCIA para presentar equivalencias. Reglas:
 *  - Fechas en America/Caracas. La tasa BCV que se aplica HOY es la de mayor
 *    «Fecha Valor» que no sea posterior a hoy. Una publicación para una fecha
 *    futura (p. ej. la del lunes publicada el viernes) se muestra como
 *    «próxima», nunca se aplica antes de su fecha.
 *  - Fines de semana y feriados: si el BCV no publicó para hoy, rige la del
 *    último día con publicación (lo confirma que exista una próxima posterior
 *    o que la fuente siga respondiendo).
 *  - Caída de la fuente: se conserva la última lectura válida con SU fecha y
 *    un aviso; jamás se reescribe su hora para parecer actual.
 *  - Sin tasa utilizable ⇒ `rate: null` y estado «no_disponible».
 *  - USDT/Bs directo: no hay fuente pública documentada y verificable
 *    configurada ⇒ no se muestra; solo la «Referencia cruzada».
 */
export const FX_TIMEZONE = 'America/Caracas';

export type FxStatus = 'vigente' | 'desactualizada' | 'no_disponible' | 'datos_de_prueba';

export interface FxReference {
  pair: 'USD/VES' | 'EUR/VES' | 'USDT/USD' | 'USDT/VES';
  kind: 'official' | 'market' | 'cross';
  label: string;
  source: string;
  method: string;
  unit: string;
  rate: string | null;
  valueDate: string | null;
  sourceUpdatedAt: string | null;
  fetchedAt: string | null;
  status: FxStatus;
  detail: string;
  warning: string | null;
  next: { valueDate: string; rate: string } | null;
}

export interface FxView {
  generatedAt: string;
  timezone: string;
  today: string;
  references: FxReference[];
  directUsdtVes: { status: 'sin_fuente'; detail: string };
  sources: Record<'bcv' | 'coingecko', SourceStatus>;
  config: FxPublicConfig;
}

export interface SourceStatus {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
}

export interface FxPublicConfig {
  refreshEnabled: boolean;
  bcvIntervalSeconds: number;
  usdtIntervalSeconds: number;
  coingeckoKey: 'sin_clave' | 'demo' | 'pro';
}

interface Row {
  source: string;
  base: string;
  quote: string;
  rate: string;
  value_date: string | null;
  source_updated_at: Date | null;
  fetched_at: Date;
}

/** Fecha civil YYYY-MM-DD en Caracas para un instante. */
export function caracasDate(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: FX_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

const norm = (r: string) => toFixed(dec(r), 8);
const iso = (d: Date | null) => (d ? d.toISOString() : null);

export class FxService {
  private cache: { at: number; view: FxView } | null = null;

  constructor(
    private readonly pool: Pool,
    private readonly cfg: FxPublicConfig,
    private readonly clock: () => Date = () => new Date(),
    private readonly cacheMs = 30_000
  ) {}

  // ── Escritura (la usa el refresco) ───────────────────────────────────────
  async saveBcv(r: BcvReading, origin: string): Promise<number> {
    let inserted = 0;
    for (const [base, rate] of [
      ['USD', r.usdVes],
      ['EUR', r.eurVes],
    ] as const) {
      const res = await this.pool.query(
        `INSERT INTO fx_rate_readings
           (source, base, quote, rate, method, value_date, operation_date, origin, fetched_at)
         VALUES ('bcv', $1, 'VES', $2, 'official_reference', $3, $4, $5, $6)
         ON CONFLICT DO NOTHING`,
        [base, rate, r.valueDate, r.operationDate, origin, this.clock().toISOString()]
      );
      inserted += res.rowCount ?? 0;
    }
    this.cache = null;
    return inserted;
  }

  async saveUsdt(r: UsdtReading, origin: string): Promise<number> {
    const res = await this.pool.query(
      `INSERT INTO fx_rate_readings
         (source, base, quote, rate, method, source_updated_at, origin, fetched_at)
       VALUES ('coingecko', 'USDT', 'USD', $1, 'market_aggregate', $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [r.usdtUsd, r.sourceUpdatedAt, origin, this.clock().toISOString()]
    );
    this.cache = null;
    return res.rowCount ?? 0;
  }

  async recordAttempt(source: 'bcv' | 'coingecko', ok: boolean, error?: string): Promise<void> {
    const at = this.clock().toISOString();
    await this.pool.query(
      ok
        ? `UPDATE fx_source_status SET last_attempt_at = $2, last_success_at = $2,
             last_error = NULL, consecutive_failures = 0 WHERE source = $1`
        : `UPDATE fx_source_status SET last_attempt_at = $2, last_error = left($3, 300),
             consecutive_failures = consecutive_failures + 1 WHERE source = $1`,
      ok ? [source, at] : [source, at, error ?? 'error']
    );
    this.cache = null;
  }

  async sourceStatus(source: 'bcv' | 'coingecko'): Promise<SourceStatus> {
    const r = await this.pool.query<{
      last_attempt_at: Date | null;
      last_success_at: Date | null;
      last_error: string | null;
      consecutive_failures: number;
    }>(`SELECT * FROM fx_source_status WHERE source = $1`, [source]);
    const s = r.rows[0];
    return {
      lastAttemptAt: iso(s?.last_attempt_at ?? null),
      lastSuccessAt: iso(s?.last_success_at ?? null),
      lastError: s?.last_error ?? null,
      consecutiveFailures: s?.consecutive_failures ?? 0,
    };
  }

  /** ¿Hay una lectura BCV aplicable hoy (Fecha Valor ≤ hoy)? */
  async hasApplicableBcv(today: string): Promise<boolean> {
    const r = await this.pool.query(
      `SELECT 1 FROM fx_rate_readings WHERE base = 'USD' AND quote = 'VES'
         AND value_date <= $1 LIMIT 1`,
      [today]
    );
    return (r.rowCount ?? 0) > 0;
  }

  // ── Lectura ──────────────────────────────────────────────────────────────
  async view(): Promise<FxView> {
    const now = this.clock();
    if (this.cache && now.getTime() - this.cache.at < this.cacheMs) return this.cache.view;
    const today = caracasDate(now);
    const [bcv, cg] = await Promise.all([this.sourceStatus('bcv'), this.sourceStatus('coingecko')]);
    const official = async (base: 'USD' | 'EUR') => {
      const r = await this.pool.query<Row>(
        `(SELECT source, base, quote, rate::text, value_date::text, source_updated_at, fetched_at
            FROM fx_rate_readings WHERE base = $1 AND quote = 'VES' AND value_date <= $2
           ORDER BY value_date DESC, fetched_at DESC LIMIT 1)
         UNION ALL
         (SELECT source, base, quote, rate::text, value_date::text, source_updated_at, fetched_at
            FROM fx_rate_readings WHERE base = $1 AND quote = 'VES' AND value_date > $2
           ORDER BY value_date ASC, fetched_at DESC LIMIT 1)`,
        [base, today]
      );
      const applicable = r.rows.find((x) => x.value_date! <= today) ?? null;
      const next = r.rows.find((x) => x.value_date! > today) ?? null;
      return this.officialRef(base, applicable, next, today, now, bcv);
    };
    const usd = await official('USD');
    const eur = await official('EUR');
    const m = await this.pool.query<Row>(
      `SELECT source, base, quote, rate::text, value_date::text, source_updated_at, fetched_at
         FROM fx_rate_readings WHERE base = 'USDT' AND quote = 'USD'
        ORDER BY source_updated_at DESC NULLS LAST, fetched_at DESC LIMIT 1`
    );
    const usdt = this.marketRef(m.rows[0] ?? null, now, cg);
    const view: FxView = {
      generatedAt: now.toISOString(),
      timezone: FX_TIMEZONE,
      today,
      references: [usd, eur, usdt, this.crossRef(usdt, usd)],
      directUsdtVes: {
        status: 'sin_fuente',
        detail:
          'No hay configurada una fuente pública, documentada y verificable de cotización directa USDT/Bs (mercado, dirección compra/venta y método). No se muestra un precio P2P.',
      },
      sources: { bcv, coingecko: cg },
      config: this.cfg,
    };
    this.cache = { at: now.getTime(), view };
    return view;
  }

  private healthy(s: SourceStatus, intervalS: number, now: Date): boolean {
    if (!s.lastSuccessAt) return false;
    const limit = Math.max(3 * intervalS * 1000, 2 * 3600_000);
    return now.getTime() - Date.parse(s.lastSuccessAt) <= limit;
  }

  private outageWarning(s: SourceStatus, name: string, healthy: boolean): string | null {
    if (healthy || !this.cfg.refreshEnabled) return null;
    return s.lastSuccessAt
      ? `No pudimos consultar ${name} desde ${s.lastSuccessAt}. Se muestra la última lectura válida con su fecha.`
      : `Aún no hay una consulta exitosa a ${name}.`;
  }

  private officialRef(
    base: 'USD' | 'EUR',
    row: Row | null,
    next: Row | null,
    today: string,
    now: Date,
    s: SourceStatus
  ): FxReference {
    const healthy = this.healthy(s, this.cfg.bcvIntervalSeconds, now);
    const ref: FxReference = {
      pair: `${base}/VES`,
      kind: 'official',
      label: `${base}/Bs`,
      source: 'BCV',
      method: 'Tipo de cambio de referencia oficial (Bs por unidad, «Venta»)',
      unit: `Bs por 1 ${base}`,
      rate: row ? norm(row.rate) : null,
      valueDate: row?.value_date ?? null,
      sourceUpdatedAt: null,
      fetchedAt: iso(row?.fetched_at ?? null),
      status: 'no_disponible',
      detail: '',
      warning: this.outageWarning(s, 'al BCV', healthy),
      next: next ? { valueDate: next.value_date!, rate: norm(next.rate) } : null,
    };
    if (!row) {
      ref.detail = next
        ? `La última publicación del BCV rige desde el ${next.value_date}; no hay una tasa aplicable registrada para hoy (${today}).`
        : 'No hay lecturas del BCV registradas.';
      return ref;
    }
    if (row.source === 'fixture') {
      ref.status = 'datos_de_prueba';
      ref.source = 'Datos de prueba';
      ref.detail = 'Valor de prueba (fixture), no es una tasa real.';
      return ref;
    }
    const v = row.value_date!;
    if (v === today) {
      ref.status = 'vigente';
      ref.detail = `Fecha Valor ${v} (hoy).`;
    } else if (next) {
      ref.status = 'vigente';
      ref.detail = `Rige la Fecha Valor ${v} hasta la próxima publicada (${next.value_date}).`;
    } else if (healthy && daysBetween(v, today) <= 4) {
      ref.status = 'vigente';
      ref.detail = `El BCV no ha publicado para hoy; rige la del último día con publicación (${v}).`;
    } else {
      ref.status = 'desactualizada';
      ref.detail = `Última Fecha Valor registrada: ${v}.`;
    }
    return ref;
  }

  private marketRef(row: Row | null, now: Date, s: SourceStatus): FxReference {
    const healthy = this.healthy(s, this.cfg.usdtIntervalSeconds, now);
    const ref: FxReference = {
      pair: 'USDT/USD',
      kind: 'market',
      label: 'USDT/USD',
      source: 'CoinGecko',
      method: 'Precio agregado de mercado (API simple/price, id «tether»)',
      unit: 'USD por 1 USDT',
      rate: row ? norm(row.rate) : null,
      valueDate: null,
      sourceUpdatedAt: iso(row?.source_updated_at ?? null),
      fetchedAt: iso(row?.fetched_at ?? null),
      status: 'no_disponible',
      detail: row ? '' : 'Sin cotización de USDT registrada.',
      warning: this.outageWarning(s, 'a CoinGecko', healthy),
      next: null,
    };
    if (!row) return ref;
    if (row.source === 'fixture') {
      ref.status = 'datos_de_prueba';
      ref.source = 'Datos de prueba';
      ref.detail = 'Valor de prueba (fixture), no es una cotización real.';
      return ref;
    }
    const ageMin = Math.round((now.getTime() - row.source_updated_at!.getTime()) / 60_000);
    ref.status = ageMin <= 30 ? 'vigente' : 'desactualizada';
    ref.detail = `Actualizada por la fuente hace ${ageMin} min.`;
    return ref;
  }

  private crossRef(usdt: FxReference, usd: FxReference): FxReference {
    const ok = usdt.rate !== null && usd.rate !== null;
    const worst: FxStatus = !ok
      ? 'no_disponible'
      : [usdt.status, usd.status].includes('datos_de_prueba')
        ? 'datos_de_prueba'
        : [usdt.status, usd.status].includes('desactualizada')
          ? 'desactualizada'
          : 'vigente';
    return {
      pair: 'USDT/VES',
      kind: 'cross',
      label: 'USDT/Bs',
      source: 'Referencia cruzada',
      method: 'USDT/USD (CoinGecko) × USD/Bs (BCV). No es un precio P2P ni ejecutable.',
      unit: 'Bs por 1 USDT',
      rate: ok ? toFixed(mul(dec(usdt.rate!), dec(usd.rate!)), 8) : null,
      valueDate: usd.valueDate,
      sourceUpdatedAt: usdt.sourceUpdatedAt,
      fetchedAt: null,
      status: worst,
      detail: ok
        ? `Calculada con USDT/USD ${usdt.rate} y USD/Bs ${usd.rate} (Fecha Valor ${usd.valueDate}).`
        : 'Falta USDT/USD o USD/Bs.',
      warning: usdt.warning ?? usd.warning,
      next: null,
    };
  }
}
