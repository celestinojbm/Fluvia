import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '@fluvia/db/testing';
import { BcvFormatError, bcvHistoryFile, parseBcvHistoryXls, parseBcvHome } from '../src/fx/bcv.js';
import { CoinGeckoFormatError, coinGeckoRequest, parseCoinGecko } from '../src/fx/coingecko.js';
import { InvalidRateError, parseDecimalRate } from '../src/fx/rate.js';
import { FxRefresher, type FxRefreshConfig } from '../src/fx/refresher.js';
import { FxService, caracasDate } from '../src/fx/service.js';
import type { FetchLike } from '../src/fx/http.js';

/**
 * Tasas de referencia: parsers contra las publicaciones OFICIALES guardadas
 * (portada del BCV y su histórico XLS del 2026-10-03), reglas de vigencia y
 * refresco contra PostgreSQL REAL con reloj y red simulados (sin internet).
 */
const FIX = new URL('./fixtures/fx/', import.meta.url);
const HOME = readFileSync(new URL('bcv-portada-2026-10-03.html', FIX), 'utf8');
const XLS = readFileSync(new URL('bcv-2_1_2d26_smc.xls', FIX));

describe('parsers (publicaciones oficiales)', () => {
  it('portada del BCV: USD, EUR y Fecha Valor (aquí FUTURA: lunes 05/10)', () => {
    expect(parseBcvHome(HOME)).toEqual({
      valueDate: '2026-10-05',
      operationDate: null,
      usdVes: '871.36890000',
      eurVes: '981.17880877',
    });
  });

  it('histórico XLS: una lectura por hoja, con Fecha Operación y Fecha Valor', () => {
    expect(parseBcvHistoryXls(XLS)).toEqual([
      {
        valueDate: '2026-10-05',
        operationDate: '2026-10-02',
        usdVes: '871.36890000',
        eurVes: '981.17880877',
      },
      // El pie «…para la fecha valor establecida…» NO pisa la fecha.
      {
        valueDate: '2026-10-02',
        operationDate: '2026-10-01',
        usdVes: '866.56120000',
        eurVes: '973.92813268',
      },
    ]);
  });

  it('estructuras inesperadas fallan, nunca inventan un valor', () => {
    expect(() => parseBcvHome('<html>sin tasas</html>')).toThrow(BcvFormatError);
    expect(() => parseBcvHome(HOME.replace(/Fecha Valor:/, 'Fecha:'))).toThrow(BcvFormatError);
    expect(() => parseBcvHistoryXls(Buffer.from('no es un xls'))).toThrow(BcvFormatError);
    expect(() => parseBcvHistoryXls(XLS.subarray(0, 600))).toThrow();
  });

  it('archivo trimestral del histórico según la fecha', () => {
    expect(bcvHistoryFile('2026-10-03')).toMatch(/2_1_2d26_smc\.xls$/);
    expect(bcvHistoryFile('2026-01-01')).toMatch(/2_1_2a26_smc\.xls$/);
  });

  it('tasas inválidas: cero, negativas, exponentes, texto, vacías', () => {
    expect(parseDecimalRate('871,36890000')).toBe('871.36890000');
    expect(parseDecimalRate('1.234,5')).toBe('1234.5');
    for (const bad of ['0', '0,00', '-1', '1e5', 'abc', '', 'NaN', '1.2.3,4,5']) {
      expect(() => parseDecimalRate(bad), bad).toThrow(InvalidRateError);
    }
  });

  it('CoinGecko simple/price: precio y hora de la fuente; rechaza respuestas raras', () => {
    expect(parseCoinGecko({ tether: { usd: 0.9998897, last_updated_at: 1791052070 } })).toEqual({
      usdtUsd: '0.99988970',
      sourceUpdatedAt: '2026-10-03T18:27:50.000Z',
    });
    for (const bad of [
      null,
      {},
      { tether: { usd: 0, last_updated_at: 1 } },
      { tether: { usd: 1 } },
      { tether: { usd: 50, last_updated_at: 1 } },
    ]) {
      expect(() => parseCoinGecko(bad)).toThrow(CoinGeckoFormatError);
    }
    expect(
      coinGeckoRequest({ baseUrl: 'https://api.coingecko.com/api/v3', apiKey: 'k', pro: false })
    ).toEqual({
      url: 'https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=usd&include_last_updated_at=true&precision=full',
      headers: { accept: 'application/json', 'x-cg-demo-api-key': 'k' },
    });
  });

  it('fecha de Caracas (UTC−4) para instantes cerca de medianoche', () => {
    expect(caracasDate(new Date('2026-10-03T03:59:00Z'))).toBe('2026-10-02');
    expect(caracasDate(new Date('2026-10-03T04:00:00Z'))).toBe('2026-10-03');
  });
});

describe('vigencia y refresco (PostgreSQL real, sin red)', () => {
  let ctx: TestContext;
  let now = new Date('2026-10-03T15:00:00Z'); // sábado 03/10, 11:00 en Caracas
  const clock = () => now;
  const cfg = {
    refreshEnabled: true,
    bcvIntervalSeconds: 1800,
    usdtIntervalSeconds: 300,
    coingeckoKey: 'sin_clave' as const,
  };
  const svc = () => new FxService(ctx.app, cfg, clock, 0);

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 30_000);
  afterAll(async () => ctx.close());
  beforeEach(async () => {
    // Tablas GLOBALES: cada prueba parte de cero (solo en la base de pruebas).
    await ctx.admin.query('TRUNCATE fx_rate_readings');
    await ctx.admin.query(
      'UPDATE fx_source_status SET last_attempt_at = NULL, last_success_at = NULL, last_error = NULL, consecutive_failures = 0'
    );
    now = new Date('2026-10-03T15:00:00Z');
  });

  const ref = (v: Awaited<ReturnType<FxService['view']>>, pair: string) =>
    v.references.find((r) => r.pair === pair)!;

  it('publicación FUTURA (lunes) no se aplica el sábado; rige la del viernes y se muestra la próxima', async () => {
    const fx = svc();
    for (const r of parseBcvHistoryXls(XLS)) await fx.saveBcv(r, 'test');
    await fx.recordAttempt('bcv', true);
    const v = await fx.view();
    expect(v.today).toBe('2026-10-03');
    const usd = ref(v, 'USD/VES');
    expect(usd).toMatchObject({
      rate: '866.56120000',
      valueDate: '2026-10-02',
      status: 'vigente',
      next: { valueDate: '2026-10-05', rate: '871.36890000' },
    });
    expect(ref(v, 'EUR/VES')).toMatchObject({
      rate: '973.92813268',
      valueDate: '2026-10-02',
      status: 'vigente',
    });
    // El lunes ya rige la del lunes.
    now = new Date('2026-10-05T13:00:00Z');
    const mon = ref(await svc().view(), 'USD/VES');
    expect(mon).toMatchObject({
      rate: '871.36890000',
      valueDate: '2026-10-05',
      status: 'vigente',
      next: null,
    });
  });

  it('solo hay una publicación futura ⇒ «No disponible» para hoy (nunca se adelanta)', async () => {
    const fx = svc();
    await fx.saveBcv(parseBcvHome(HOME), 'test');
    const usd = ref(await fx.view(), 'USD/VES');
    expect(usd.rate).toBeNull();
    expect(usd.status).toBe('no_disponible');
    expect(usd.next).toEqual({ valueDate: '2026-10-05', rate: '871.36890000' });
    expect(ref(await fx.view(), 'USDT/VES')).toMatchObject({ rate: null, status: 'no_disponible' });
  });

  it('feriado o sin publicación reciente: vigente unos días con la fuente sana; antigua ⇒ desactualizada', async () => {
    const fx = svc();
    await fx.saveBcv(
      { valueDate: '2026-10-01', operationDate: null, usdVes: '860.1', eurVes: '970.2' },
      'test'
    );
    await fx.recordAttempt('bcv', true);
    expect(ref(await fx.view(), 'USD/VES')).toMatchObject({
      status: 'vigente',
      valueDate: '2026-10-01',
    });
    now = new Date('2026-10-20T15:00:00Z');
    await fx.recordAttempt('bcv', true);
    expect(ref(await svc().view(), 'USD/VES')).toMatchObject({
      status: 'desactualizada',
      rate: '860.10000000',
    });
  });

  it('proveedor caído: conserva la última lectura con SU fecha y avisa; no la re-fecha', async () => {
    const fx = svc();
    await fx.saveBcv(
      { valueDate: '2026-10-02', operationDate: null, usdVes: '866.5612', eurVes: '973.92813268' },
      'test'
    );
    await fx.recordAttempt('bcv', true);
    const before = ref(await fx.view(), 'USD/VES');
    now = new Date('2026-10-03T23:00:00Z'); // 8 h sin éxito
    const failing = new FxRefresher(
      ctx.app,
      fx,
      refreshCfg(),
      quietLog,
      failFetch,
      clock,
      async () => {}
    );
    expect(await failing.refresh('bcv')).toBe(false);
    const after = ref(await svc().view(), 'USD/VES');
    expect(after.rate).toBe(before.rate);
    expect(after.fetchedAt).toBe(before.fetchedAt);
    expect(after.warning).toMatch(/No pudimos consultar al BCV/);
    const st = await fx.sourceStatus('bcv');
    expect(st.consecutiveFailures).toBe(1);
    expect(st.lastError).toMatch(/caído/);
  });

  it('USDT: sin cotización ⇒ no disponible (nunca USDT = USD); con cotización ⇒ referencia cruzada exacta', async () => {
    const fx = svc();
    await fx.saveBcv(
      { valueDate: '2026-10-02', operationDate: null, usdVes: '866.5612', eurVes: '973.92813268' },
      'test'
    );
    await fx.recordAttempt('bcv', true);
    let v = await fx.view();
    expect(ref(v, 'USDT/USD')).toMatchObject({ rate: null, status: 'no_disponible' });
    expect(ref(v, 'USDT/VES')).toMatchObject({ rate: null, status: 'no_disponible' });
    expect(v.directUsdtVes.status).toBe('sin_fuente');
    await fx.saveUsdt(
      { usdtUsd: '0.99988979', sourceUpdatedAt: '2026-10-03T14:55:00.000Z' },
      'test'
    );
    v = await svc().view();
    expect(ref(v, 'USDT/USD')).toMatchObject({ rate: '0.99988979', status: 'vigente' });
    expect(ref(v, 'USDT/VES')).toMatchObject({
      kind: 'cross',
      source: 'Referencia cruzada',
      rate: '866.46569629',
      status: 'vigente',
    });
    now = new Date('2026-10-03T16:00:00Z'); // 65 min sin actualización de la fuente
    expect(ref(await svc().view(), 'USDT/USD').status).toBe('desactualizada');
  });

  it('refresco: portada futura ⇒ trae el histórico; segunda corrida reciente no consulta; sin duplicados', async () => {
    const fx = svc();
    const calls: string[] = [];
    const fetch: FetchLike = async (url) => {
      calls.push(url);
      if (url.endsWith('.xls'))
        return { status: 200, body: XLS, contentType: 'application/vnd.ms-excel' };
      if (url.includes('coingecko')) {
        return {
          status: 200,
          body: Buffer.from(
            JSON.stringify({
              tether: { usd: 0.9998, last_updated_at: Date.parse('2026-10-03T14:58:00Z') / 1000 },
            })
          ),
          contentType: 'application/json',
        };
      }
      return { status: 200, body: Buffer.from(HOME), contentType: 'text/html' };
    };
    const r = new FxRefresher(ctx.app, fx, refreshCfg(), quietLog, fetch, clock, async () => {});
    expect(await r.refresh('bcv')).toBe(true);
    expect(calls).toEqual(['https://www.bcv.org.ve/', expect.stringMatching(/2_1_2d26_smc\.xls$/)]);
    expect(await r.refresh('bcv')).toBeNull(); // reciente: no vuelve a consultar
    expect(await r.refresh('coingecko')).toBe(true);
    const n = await ctx.admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM fx_rate_readings'
    );
    expect(n.rows[0]!.n).toBe(5); // 2 Fecha Valor × (USD, EUR) + 1 USDT
    now = new Date('2026-10-03T16:00:00Z');
    expect(await r.refresh('bcv')).toBe(true); // nueva consulta: ON CONFLICT, sin duplicar
    const m = await ctx.admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM fx_rate_readings'
    );
    expect(m.rows[0]!.n).toBe(5);
  });

  it('reintentos ACOTADOS con backoff exponencial y 429 respetado', async () => {
    const fx = svc();
    const waits: number[] = [];
    let n = 0;
    const fetch: FetchLike = async () => {
      n++;
      return { status: n === 1 ? 429 : 503, body: Buffer.alloc(0), contentType: '' };
    };
    const r = new FxRefresher(ctx.app, fx, refreshCfg(), quietLog, fetch, clock, async (ms) => {
      waits.push(ms);
    });
    expect(await r.refresh('coingecko')).toBe(false);
    expect(n).toBe(3); // maxAttempts
    expect(waits).toEqual([60_000, 2_000 * 2]);
  });

  it('las lecturas son append-only: ni el rol de la app ni un UPDATE directo las cambian', async () => {
    const fx = svc();
    await fx.saveUsdt({ usdtUsd: '1.0001', sourceUpdatedAt: '2026-10-03T14:00:00.000Z' }, 'test');
    await expect(ctx.app.query(`UPDATE fx_rate_readings SET fetched_at = now()`)).rejects.toThrow();
    await expect(ctx.app.query(`DELETE FROM fx_rate_readings`)).rejects.toThrow();
    await expect(
      ctx.app.query(
        `INSERT INTO fx_rate_readings (source, base, quote, rate, method, source_updated_at, origin) VALUES ('coingecko','USDT','USD',0,'market_aggregate',now(),'x')`
      )
    ).rejects.toThrow();
  });
});

const quietLog = { info: () => {}, warn: () => {} };
const failFetch: FetchLike = async () => {
  throw new Error('BCV caído (simulado)');
};
function refreshCfg(): FxRefreshConfig {
  return {
    enabled: true,
    bcvUrl: 'https://www.bcv.org.ve/',
    bcvIntervalSeconds: 1800,
    usdtIntervalSeconds: 300,
    coingeckoBaseUrl: 'https://api.coingecko.com/api/v3',
    coingeckoApiKey: null,
    coingeckoPro: false,
    timeoutMs: 1000,
    maxAttempts: 3,
    backoffBaseMs: 2000,
  };
}
