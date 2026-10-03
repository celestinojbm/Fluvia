import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import {
  convertDecimal,
  convertMinor,
  currencyLabel,
  formatDisplay,
  parseUserAmount,
  type FxRates,
  type FxReference,
} from '../app/lib/fx';
import {
  ConvertedAmount,
  DisplaySelect,
  Equivalence,
  FxProvider,
  RatesStrip,
} from '../app/lib/fx-ui';

const nbsp = (s: string | null | undefined) => (s ?? '').replace(/\u00a0/g, ' ');

function ref(pair: FxReference['pair'], rate: string | null, extra: Partial<FxReference> = {}) {
  return {
    pair,
    kind: pair === 'USDT/USD' ? 'market' : pair === 'USDT/VES' ? 'cross' : 'official',
    label: pair,
    source: pair === 'USDT/USD' ? 'CoinGecko' : pair === 'USDT/VES' ? 'Referencia cruzada' : 'BCV',
    method: 'm',
    unit: 'u',
    rate,
    value_date: pair === 'USDT/USD' ? null : '2026-10-02',
    source_updated_at: null,
    fetched_at: null,
    status: rate ? 'vigente' : 'no_disponible',
    detail: '',
    warning: null,
    next: null,
    ...extra,
  } as FxReference;
}

// Cifras del histórico oficial (Fecha Valor 02/10/2026) y CoinGecko; aquí
// solo como datos de prueba de la aritmética.
const RATES: FxRates = {
  generated_at: '2026-10-03T15:00:00Z',
  timezone: 'America/Caracas',
  today: '2026-10-03',
  references: [
    ref('USD/VES', '866.5612'),
    ref('EUR/VES', '973.92813268'),
    ref('USDT/USD', '0.99988979'),
    ref('USDT/VES', '866.46569629'),
  ],
  direct_usdt_ves: { status: 'sin_fuente', detail: 'sin fuente' },
};

describe('fx — aritmética exacta y sentidos de conversión', () => {
  it('Bs → USD divide; USD → Bs multiplica (sentido correcto)', () => {
    expect(convertDecimal(RATES, '866.5612', 'VES', 'USD')!.value).toBe('1.00');
    expect(convertDecimal(RATES, '1', 'USD', 'VES')!.value).toBe('866.56');
    expect(convertDecimal(RATES, '100', 'USD', 'VES')!.rate).toBe('866.56120000');
    expect(convertDecimal(RATES, '100', 'VES', 'USD')!.rate).toBe('0.00115399');
  });

  it('cruces EUR↔USD y USDT↔Bs vía el pivote en bolívares, sin USDT = USD', () => {
    // 100 EUR · 973,92813268 / 866,5612 = 112,3899… → 112,39
    expect(convertDecimal(RATES, '100', 'EUR', 'USD')!.value).toBe('112.39');
    // 1000 USDT · 866,46569629 = 866.465,69629 → 866.465,70
    expect(convertDecimal(RATES, '1000', 'USDT', 'VES')!.value).toBe('866465.70');
    // 100 USD en USDT: no es 100
    expect(convertDecimal(RATES, '100', 'USD', 'USDT')!.value).toBe('100.01');
  });

  it('redondeo half-up solo al presentar; minor coherente con value', () => {
    const c = convertMinor(RATES, 123456, 'VES', 'USD')!;
    expect(c.value).toBe('1.42'); // 1234,56 / 866,5612 = 1,42465…
    expect(c.minor).toBe(142n);
    expect(convertDecimal(RATES, '0.005', 'USD', 'USD')!.value).toBe('0.01');
  });

  it('importes largos sin pérdida (más allá de 2^53)', () => {
    const c = convertMinor(RATES, '900719925474099312', 'VES', 'USD')!;
    // 9.007.199.254.740.993,12 / 866,5612 exacto, redondeado a céntimos
    expect(c.value).toBe('10394187109624.79');
    expect(nbsp(formatDisplay(c.minor, 'USD'))).toBe('US$ 10.394.187.109.624,79');
  });

  it('tasas inválidas, cero o ausentes ⇒ null (nunca 0 ni USDT = USD)', () => {
    const bad = (r: string | null): FxRates => ({
      ...RATES,
      references: [
        ref('USD/VES', r),
        ref('EUR/VES', null),
        ref('USDT/USD', null),
        ref('USDT/VES', null),
      ],
    });
    expect(convertDecimal(bad('0'), '1', 'USD', 'VES')).toBeNull();
    expect(convertDecimal(bad('-1'), '1', 'USD', 'VES')).toBeNull();
    expect(convertDecimal(bad('abc'), '1', 'USD', 'VES')).toBeNull();
    expect(convertDecimal(bad(null), '1', 'USD', 'VES')).toBeNull();
    expect(convertDecimal(bad('866.5612'), '1', 'USDT', 'USD')).toBeNull();
    expect(convertDecimal(null, '1', 'USD', 'VES')).toBeNull();
    expect(convertMinor(RATES, 100, 'COP', 'USD')).toBeNull();
  });

  it('estado de la conversión: el peor de las referencias usadas', () => {
    const r: FxRates = {
      ...RATES,
      references: [
        ref('USD/VES', '866.5612', { status: 'desactualizada' }),
        ...RATES.references.slice(1),
      ],
    };
    expect(convertDecimal(r, '1', 'USD', 'VES')!.status).toBe('desactualizada');
    expect(convertDecimal(r, '1', 'EUR', 'VES')!.status).toBe('vigente');
  });

  it('formato: «Bs» sin punto, USDT con separadores locales', () => {
    expect(currencyLabel('VES')).toBe('Bs');
    expect(nbsp(formatDisplay(123456n, 'VES'))).toBe('Bs 1.234,56');
    expect(nbsp(formatDisplay(123456n, 'USDT'))).toBe('1.234,56 USDT');
    expect(nbsp(formatDisplay(123456n, 'EUR'))).toBe('EUR 1.234,56');
  });

  it('entrada de la calculadora: coma decimal, miles con punto, inválidos', () => {
    expect(parseUserAmount('1.234,56')).toBe('1234.56');
    expect(parseUserAmount('1234,5')).toBe('1234.5');
    expect(parseUserAmount('1234.56')).toBe('1234.56');
    expect(parseUserAmount('007')).toBe('7');
    expect(parseUserAmount('1,2,3')).toBeNull();
    expect(parseUserAmount('-5')).toBeNull();
    expect(parseUserAmount('abc')).toBeNull();
    expect(parseUserAmount('')).toBeNull();
  });
});

describe('fx-ui — la moneda de visualización no cambia importes', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.cookie = 'fluvia_display=; Path=/; Max-Age=0';
  });

  it('ConvertedAmount: protagonista en USD con el original visible; cambiar a Bs/EUR/USDT no toca el original', () => {
    render(
      <FxProvider initialRates={RATES} initialDisplay="USD">
        <DisplaySelect compact />
        <ConvertedAmount minor="123456" currency="VES" className="hero" />
        <Equivalence minor="199000" currency="VES" />
      </FxProvider>
    );
    const hero = () => nbsp(document.querySelector('.hero')?.textContent);
    expect(hero()).toBe('US$ 1,42');
    expect(screen.getByText('Equivalente estimado')).toBeTruthy();
    expect(nbsp(document.body.textContent)).toContain('Saldo original: Bs 1.234,56');
    expect(nbsp(document.body.textContent)).toContain('BCV · Fecha Valor 02/10/2026');

    const sel = screen.getByLabelText('Ver en') as HTMLSelectElement;
    act(() => {
      fireEvent.change(sel, { target: { value: 'EUR' } });
    });
    expect(hero()).toBe('EUR 1,27');
    act(() => {
      fireEvent.change(sel, { target: { value: 'USDT' } });
    });
    expect(hero()).toBe('1,42 USDT');
    expect(nbsp(document.body.textContent)).toContain('Saldo original: Bs 1.234,56');
    act(() => {
      fireEvent.change(sel, { target: { value: 'VES' } });
    });
    // En su propia moneda: solo el original, sin «Equivalente estimado».
    expect(hero()).toBe('Bs 1.234,56');
    expect(screen.queryByText('Equivalente estimado')).toBeNull();
    expect(document.cookie).toContain('fluvia_display=VES');
  });

  it('sin tasas: el original sigue siendo protagonista y se dice «no disponible»', () => {
    render(
      <FxProvider initialRates={null} initialDisplay="USD">
        <ConvertedAmount minor="123456" currency="VES" className="hero2" />
      </FxProvider>
    );
    expect(nbsp(document.querySelector('.hero2')?.textContent)).toBe('Bs 1.234,56');
    expect(document.body.textContent).toContain('Equivalente en USD: no disponible');
  });

  it('calculadora (dentro del detalle): resultado, tasa usada e intercambio', () => {
    render(
      <FxProvider initialRates={RATES} initialDisplay="USD">
        <RatesStrip />
      </FxProvider>
    );
    // Cerrado, el detalle no existe en el DOM (no duplica «Importe» de la página).
    expect(document.querySelector('.rt-calc')).toBeNull();
    act(() => {
      fireEvent.click(document.querySelector('.rt-strip-btn')!);
    });
    const calc = document.querySelector('.rt-calc') as HTMLElement;
    const out = () => nbsp(calc.querySelector('output')?.textContent);
    expect(out()).toBe('Bs 86.656,12'); // 100 USD → Bs
    expect(nbsp(calc.querySelector('.rt-calc-rate')?.textContent)).toContain(
      '1 USD = 866,56120000 Bs'
    );
    act(() => {
      fireEvent.click(calc.querySelector('.rt-swap')!);
    });
    expect(out()).toBe('US$ 0,12'); // 100 Bs → USD
    act(() => {
      fireEvent.change(within(calc).getByLabelText('Importe'), { target: { value: '1,2,3' } });
    });
    expect(nbsp(calc.querySelector('.rt-calc-err')?.textContent)).toContain('importe válido');
    expect(out()).toBe('—');
  });
});
