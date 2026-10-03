import { readXls, XlsFormatError } from './xls.js';
import { parseDecimalRate, rateFromDouble } from './rate.js';

/**
 * Tipo de cambio de REFERENCIA del BCV (publicación oficial):
 *  - Portada https://www.bcv.org.ve/ → bloques #dolar y #euro (Bs por unidad,
 *    columna «Venta») y la «Fecha Valor» (día en que RIGE, no el de consulta).
 *  - Histórico trimestral (XLS) → una hoja por día de operación con su Fecha
 *    Operación y Fecha Valor; se usa para conocer la tasa que rige HOY cuando
 *    la portada ya muestra la del próximo día hábil (viernes → lunes).
 * Cualquier forma inesperada lanza error: nunca se infiere un valor.
 */
export interface BcvReading {
  valueDate: string; // YYYY-MM-DD (America/Caracas)
  operationDate: string | null;
  usdVes: string;
  eurVes: string;
}

export class BcvFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BcvFormatError';
  }
}

function blockValue(html: string, id: 'dolar' | 'euro'): string {
  const m = new RegExp(
    `<div id="${id}"[\\s\\S]*?<strong[^>]*>\\s*([0-9.,]+)\\s*</strong>`,
    'i'
  ).exec(html);
  if (!m) throw new BcvFormatError(`portada sin bloque #${id}`);
  return parseDecimalRate(m[1]!);
}

export function parseBcvHome(html: string): BcvReading {
  const usdVes = blockValue(html, 'dolar');
  const eurVes = blockValue(html, 'euro');
  const fv = /Fecha Valor:\s*<span[^>]*content="(\d{4}-\d{2}-\d{2})T/i.exec(html);
  if (!fv) throw new BcvFormatError('portada sin «Fecha Valor»');
  return { valueDate: fv[1]!, operationDate: null, usdVes, eurVes };
}

const DMY = /(\d{2})\/(\d{2})\/(\d{4})/;
const ymd = (s: string): string | null => {
  const m = DMY.exec(s);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};

/** Histórico XLS del BCV: una lectura por hoja (día de operación). */
export function parseBcvHistoryXls(buf: Buffer): BcvReading[] {
  let sheets;
  try {
    sheets = readXls(buf);
  } catch (e) {
    if (e instanceof XlsFormatError) throw new BcvFormatError(`XLS: ${e.message}`);
    throw e;
  }
  const out: BcvReading[] = [];
  for (const s of sheets) {
    let valueDate: string | null = null;
    let operationDate: string | null = null;
    let usd: number | null = null;
    let eur: number | null = null;
    for (const row of s.rows) {
      if (!row) continue;
      for (const cell of row) {
        if (typeof cell !== 'string') continue;
        // Solo «Fecha Valor: dd/mm/aaaa»: el pie de la hoja dice «…para la fecha
        // valor establecida…» y no debe pisar la fecha.
        const fv = /Fecha\s+Valor\s*:\s*(\d{2}\/\d{2}\/\d{4})/i.exec(cell);
        if (fv) valueDate = ymd(fv[1]!);
        const fo = /Fecha\s+Operaci\S*\s*:\s*(\d{2}\/\d{2}\/\d{4})/i.exec(cell);
        if (fo) operationDate = ymd(fo[1]!);
      }
      const code = typeof row[1] === 'string' ? row[1].trim() : '';
      // Columna «Bs./M.E. Venta (ASK)» = índice 6 (la misma cifra de la portada).
      if (code === 'USD' && typeof row[6] === 'number') usd = row[6];
      if (code === 'EUR' && typeof row[6] === 'number') eur = row[6];
    }
    if (!valueDate || usd === null || eur === null) {
      throw new BcvFormatError(`hoja ${s.name}: falta Fecha Valor, USD o EUR`);
    }
    out.push({
      valueDate,
      operationDate,
      usdVes: rateFromDouble(usd),
      eurVes: rateFromDouble(eur),
    });
  }
  return out;
}

/** Archivo del trimestre del BCV (2_1_2{a..d}{YY}_smc.xls) para una fecha. */
export function bcvHistoryFile(date: string): string {
  const [y, m] = date.split('-').map(Number) as [number, number];
  const q = 'abcd'[Math.floor((m - 1) / 3)]!;
  return `https://www.bcv.org.ve/sites/default/files/EstadisticasGeneral/2_1_2${q}${String(y).slice(2)}_smc.xls`;
}
