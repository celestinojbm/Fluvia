import { inflateSync } from 'node:zlib';

/**
 * Extractor MÍNIMO de texto de los PDF que genera Chromium (Skia) con
 * `page.pdf()`, sin dependencias: objetos, streams Flate, CMaps `ToUnicode`
 * (bfchar/bfrange) y operadores `Tf`, `Tj`, `TJ`. Solo para que el E2E pueda
 * leer el encabezado/pie de página impreso; no es un parser PDF general.
 */

interface PdfObject {
  dict: string;
  stream: Buffer | null;
}

function objects(pdf: Buffer): Map<number, PdfObject> {
  const text = pdf.toString('latin1');
  const out = new Map<number, PdfObject>();
  const re = /(\d+) 0 obj([\s\S]*?)endobj/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const body = m[2]!;
    const s = body.indexOf('stream');
    if (s === -1) {
      out.set(Number(m[1]), { dict: body, stream: null });
      continue;
    }
    const dict = body.slice(0, s);
    let start = s + 'stream'.length;
    if (body[start] === '\r') start++;
    if (body[start] === '\n') start++;
    const end = body.lastIndexOf('endstream');
    let raw = Buffer.from(body.slice(start, end), 'latin1');
    if (/\/FlateDecode/.test(dict)) {
      try {
        raw = inflateSync(raw);
      } catch {
        raw = Buffer.alloc(0);
      }
    }
    out.set(Number(m[1]), { dict, stream: raw });
  }
  return out;
}

interface CMap {
  bytes: number;
  map: Map<number, string>;
}

const utf16 = (hex: string) =>
  String.fromCharCode(...(hex.match(/.{1,4}/g) ?? []).map((h) => parseInt(h, 16)));

function parseCMap(src: string): CMap {
  const map = new Map<number, string>();
  const cs = /begincodespacerange\s*<([0-9a-fA-F]+)>/.exec(src);
  const bytes = cs ? cs[1]!.length / 2 : 2;
  for (const block of src.match(/beginbfchar([\s\S]*?)endbfchar/g) ?? []) {
    for (const m of block.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      map.set(parseInt(m[1]!, 16), utf16(m[2]!));
    }
  }
  for (const block of src.match(/beginbfrange([\s\S]*?)endbfrange/g) ?? []) {
    for (const m of block.matchAll(
      /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]+>|\[[^\]]*\])/g
    )) {
      const lo = parseInt(m[1]!, 16);
      const hi = parseInt(m[2]!, 16);
      if (m[3]!.startsWith('[')) {
        const items = [...m[3]!.matchAll(/<([0-9a-fA-F]+)>/g)].map((x) => utf16(x[1]!));
        items.forEach((v, i) => map.set(lo + i, v));
      } else {
        const base = parseInt(m[3]!.slice(1, -1), 16);
        for (let c = lo; c <= hi; c++) map.set(c, String.fromCharCode(base + (c - lo)));
      }
    }
  }
  return { bytes, map };
}

function decode(hex: string, cmap: CMap | undefined): string {
  if (!cmap) return '';
  const step = cmap.bytes * 2;
  let s = '';
  for (let i = 0; i + step <= hex.length; i += step) {
    s += cmap.map.get(parseInt(hex.slice(i, i + step), 16)) ?? '';
  }
  return s;
}

/** Texto del PDF, una línea por operador de texto (Tj/TJ). */
export function pdfText(pdf: Buffer): string {
  const objs = objects(pdf);
  // Fuente (objeto) → CMap ToUnicode.
  const fontCMap = new Map<number, CMap>();
  for (const [id, o] of objs) {
    const tu = /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(o.dict);
    const cm = tu ? objs.get(Number(tu[1])) : undefined;
    if (cm?.stream) fontCMap.set(id, parseCMap(cm.stream.toString('latin1')));
  }
  // Nombre de recurso (/F4) → CMap, desde los diccionarios /Font << ... >>.
  const byName = new Map<string, CMap>();
  const fontDicts = [...objs.values()].flatMap((o) => [
    ...o.dict.matchAll(/\/Font\s*<<([\s\S]*?)>>/g),
  ]);
  for (const d of fontDicts) {
    for (const m of d[1]!.matchAll(/\/([A-Za-z0-9_.+-]+)\s+(\d+)\s+0\s+R/g)) {
      const cm = fontCMap.get(Number(m[2]));
      if (cm) byName.set(m[1]!, cm);
    }
  }
  const lines: string[] = [];
  for (const o of objs.values()) {
    if (!o.stream || !/\bT[jJ]\b/.test(o.stream.toString('latin1'))) continue;
    const content = o.stream.toString('latin1');
    let font: CMap | undefined;
    const tok = /\/([A-Za-z0-9_.+-]+)\s+[\d.]+\s+Tf|<([0-9a-fA-F]*)>\s*Tj|\[([^\]]*)\]\s*TJ/g;
    for (let m = tok.exec(content); m; m = tok.exec(content)) {
      if (m[1]) font = byName.get(m[1]);
      else if (m[2] !== undefined) lines.push(decode(m[2], font));
      else if (m[3] !== undefined) {
        lines.push(
          [...m[3].matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => decode(x[1]!, font)).join('')
        );
      }
    }
  }
  return lines.join('\n');
}

/**
 * Texto sin espacios en blanco. Chrome y `headless_shell` segmentan distinto
 * (por palabra o por glifo, con los espacios como posicionamiento y no como
 * caracteres): las comprobaciones se hacen sobre esta forma compacta.
 */
export function pdfCompactText(pdf: Buffer): string {
  return pdfText(pdf).replace(/\s+/g, '');
}
