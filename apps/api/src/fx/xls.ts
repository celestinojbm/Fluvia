/**
 * Lector MÍNIMO de libros Excel 97-2003 (.xls: contenedor OLE/CFB + registros
 * BIFF8) para las publicaciones históricas del BCV. Solo extrae celdas de
 * texto y numéricas de cada hoja; no evalúa fórmulas ni estilos.
 *
 * Se escribe aquí en vez de añadir una dependencia: las librerías habituales
 * (SheetJS) arrastran avisos de seguridad que el gate de dependencias rechaza,
 * y solo necesitamos leer números y fechas. Cualquier estructura inesperada
 * lanza XlsFormatError: nunca se adivina un valor.
 */
export class XlsFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XlsFormatError';
  }
}

export type Cell = string | number;
export interface Sheet {
  name: string;
  /** rows[r][c] */
  rows: Cell[][];
}

const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;

function readCfbStream(buf: Buffer, wanted: string[]): Buffer {
  if (
    buf.length < 512 ||
    buf.readUInt32LE(0) !== 0xe011cfd0 ||
    buf.readUInt32LE(4) !== 0xe11ab1a1
  ) {
    throw new XlsFormatError('no es un contenedor OLE (CFB)');
  }
  const sectorShift = buf.readUInt16LE(30);
  const miniShift = buf.readUInt16LE(32);
  const sectorSize = 1 << sectorShift;
  const miniSize = 1 << miniShift;
  const numFatSectors = buf.readUInt32LE(44);
  const firstDirSector = buf.readUInt32LE(48);
  const miniCutoff = buf.readUInt32LE(56);
  const firstMiniFat = buf.readUInt32LE(60);
  let firstDifat = buf.readUInt32LE(68);
  const sectorOffset = (s: number) => (s + 1) * sectorSize;

  // DIFAT: 109 entradas en la cabecera + cadena de sectores DIFAT.
  const fatSectors: number[] = [];
  for (let i = 0; i < 109 && fatSectors.length < numFatSectors; i++) {
    fatSectors.push(buf.readUInt32LE(76 + i * 4));
  }
  let guard = 0;
  while (
    fatSectors.length < numFatSectors &&
    firstDifat !== ENDOFCHAIN &&
    firstDifat !== FREESECT
  ) {
    if (++guard > 10_000) throw new XlsFormatError('cadena DIFAT circular');
    const off = sectorOffset(firstDifat);
    for (let i = 0; i < sectorSize / 4 - 1 && fatSectors.length < numFatSectors; i++) {
      fatSectors.push(buf.readUInt32LE(off + i * 4));
    }
    firstDifat = buf.readUInt32LE(off + sectorSize - 4);
  }
  const fat: number[] = [];
  for (const s of fatSectors) {
    const off = sectorOffset(s);
    if (off + sectorSize > buf.length) throw new XlsFormatError('FAT fuera del archivo');
    for (let i = 0; i < sectorSize / 4; i++) fat.push(buf.readUInt32LE(off + i * 4));
  }
  const chain = (start: number, table: number[]): number[] => {
    const out: number[] = [];
    let s = start;
    while (s !== ENDOFCHAIN && s !== FREESECT) {
      if (s >= table.length || out.length > table.length)
        throw new XlsFormatError('cadena de sectores inválida');
      out.push(s);
      s = table[s]!;
    }
    return out;
  };
  const readChain = (start: number, size?: number): Buffer => {
    const parts = chain(start, fat).map((s) =>
      buf.subarray(sectorOffset(s), sectorOffset(s) + sectorSize)
    );
    const all = Buffer.concat(parts);
    return size === undefined ? all : all.subarray(0, size);
  };

  const dir = readChain(firstDirSector);
  const entries: Array<{ name: string; type: number; start: number; size: number }> = [];
  for (let off = 0; off + 128 <= dir.length; off += 128) {
    const nameLen = dir.readUInt16LE(off + 64);
    const name = dir.subarray(off, off + Math.max(0, nameLen - 2)).toString('utf16le');
    entries.push({
      name,
      type: dir[off + 66]!,
      start: dir.readUInt32LE(off + 116),
      size: dir.readUInt32LE(off + 120),
    });
  }
  const root = entries.find((e) => e.type === 5);
  if (!root) throw new XlsFormatError('sin entrada raíz');
  const entry = entries.find((e) => e.type === 2 && wanted.includes(e.name));
  if (!entry) throw new XlsFormatError(`sin flujo ${wanted.join('/')}`);
  if (entry.size >= miniCutoff) return readChain(entry.start, entry.size);

  // Flujo pequeño: vive en el mini-stream (contenido de la raíz) vía MiniFAT.
  const miniFat: number[] = [];
  if (firstMiniFat !== ENDOFCHAIN) {
    const mf = readChain(firstMiniFat);
    for (let i = 0; i + 4 <= mf.length; i += 4) miniFat.push(mf.readUInt32LE(i));
  }
  const miniStream = readChain(root.start, root.size);
  const parts = chain(entry.start, miniFat).map((s) =>
    miniStream.subarray(s * miniSize, (s + 1) * miniSize)
  );
  return Buffer.concat(parts).subarray(0, entry.size);
}

/** RK → número (BIFF8 §2.5.217). */
function rk(v: number): number {
  let n: number;
  if (v & 2) {
    n = v >> 2;
  } else {
    const b = Buffer.alloc(8);
    b.writeUInt32LE(0, 0);
    b.writeUInt32LE(v & 0xfffffffc, 4);
    n = b.readDoubleLE(0);
  }
  return v & 1 ? n / 100 : n;
}

/** Cadena Unicode de BIFF8 (XLUnicodeString) a partir de `off` en `data`. */
function readXlString(data: Buffer, off: number, lenBytes: 1 | 2): { text: string; next: number } {
  const len = lenBytes === 2 ? data.readUInt16LE(off) : data[off]!;
  let p = off + lenBytes;
  const flags = data[p]!;
  p += 1;
  const wide = flags & 1;
  let rt = 0;
  let ext = 0;
  if (flags & 8) {
    rt = data.readUInt16LE(p);
    p += 2;
  }
  if (flags & 4) {
    ext = data.readUInt32LE(p);
    p += 4;
  }
  const bytes = wide ? len * 2 : len;
  const raw = data.subarray(p, p + bytes);
  const text = wide ? raw.toString('utf16le') : raw.toString('latin1');
  return { text, next: p + bytes + rt * 4 + ext };
}

/** SST con CONTINUE: las cadenas pueden partirse entre registros. */
function readSst(chunks: Buffer[]): string[] {
  const out: string[] = [];
  let ci = 0;
  let data = chunks[0]!;
  let p = 8; // cstTotal(4) + cstUnique(4)
  const unique = data.readUInt32LE(4);
  const nextChunk = () => {
    ci += 1;
    if (ci >= chunks.length) throw new XlsFormatError('SST truncada');
    data = chunks[ci]!;
    p = 0;
  };
  for (let i = 0; i < unique; i++) {
    if (p >= data.length) nextChunk();
    const len = data.readUInt16LE(p);
    p += 2;
    let flags = data[p]!;
    p += 1;
    let rt = 0;
    let ext = 0;
    if (flags & 8) {
      rt = data.readUInt16LE(p);
      p += 2;
    }
    if (flags & 4) {
      ext = data.readUInt32LE(p);
      p += 4;
    }
    let text = '';
    let remaining = len;
    while (remaining > 0) {
      if (p >= data.length) {
        nextChunk();
        flags = data[p]!; // al continuar, un byte de opciones nuevo
        p += 1;
      }
      const wide = flags & 1;
      const avail = Math.floor((data.length - p) / (wide ? 2 : 1));
      const take = Math.min(avail, remaining);
      const raw = data.subarray(p, p + take * (wide ? 2 : 1));
      text += wide ? raw.toString('utf16le') : raw.toString('latin1');
      p += raw.length;
      remaining -= take;
    }
    let skip = rt * 4 + ext;
    while (skip > 0) {
      if (p >= data.length) nextChunk();
      const s = Math.min(skip, data.length - p);
      p += s;
      skip -= s;
    }
    out.push(text);
  }
  return out;
}

export function readXls(buf: Buffer): Sheet[] {
  const wb = readCfbStream(buf, ['Workbook', 'Book']);
  const records: Array<{ type: number; data: Buffer; offset: number }> = [];
  for (let off = 0; off + 4 <= wb.length;) {
    const type = wb.readUInt16LE(off);
    const len = wb.readUInt16LE(off + 2);
    records.push({ type, data: wb.subarray(off + 4, off + 4 + len), offset: off });
    off += 4 + len;
  }
  const sheetsMeta: Array<{ name: string; pos: number }> = [];
  let sst: string[] = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i]!;
    if (r.type === 0x0085) {
      const pos = r.data.readUInt32LE(0);
      const { text } = readXlString(r.data, 6, 1);
      if (r.data[5] === 0) sheetsMeta.push({ name: text, pos }); // solo hojas de cálculo
    } else if (r.type === 0x00fc) {
      const chunks = [r.data];
      while (records[i + 1]?.type === 0x003c) chunks.push(records[++i]!.data);
      sst = readSst(chunks);
    }
  }
  const byOffset = new Map(records.map((r, i) => [r.offset, i]));
  return sheetsMeta.map(({ name, pos }) => {
    const rows: Cell[][] = [];
    const set = (r: number, c: number, v: Cell) => {
      (rows[r] ??= [])[c] = v;
    };
    let i = byOffset.get(pos);
    if (i === undefined) throw new XlsFormatError(`hoja ${name}: posición inválida`);
    for (i += 1; i < records.length; i++) {
      const { type, data } = records[i]!;
      if (type === 0x000a) break; // EOF de la hoja
      if (type === 0x00fd)
        set(data.readUInt16LE(0), data.readUInt16LE(2), sst[data.readUInt32LE(6)] ?? '');
      else if (type === 0x0203)
        set(data.readUInt16LE(0), data.readUInt16LE(2), data.readDoubleLE(6));
      else if (type === 0x027e)
        set(data.readUInt16LE(0), data.readUInt16LE(2), rk(data.readInt32LE(6)));
      else if (type === 0x00bd) {
        const row = data.readUInt16LE(0);
        const first = data.readUInt16LE(2);
        const n = (data.length - 6) / 6;
        for (let k = 0; k < n; k++) set(row, first + k, rk(data.readInt32LE(4 + k * 6 + 2)));
      } else if (type === 0x0204) {
        set(data.readUInt16LE(0), data.readUInt16LE(2), readXlString(data, 6, 2).text);
      }
    }
    return { name, rows };
  });
}
