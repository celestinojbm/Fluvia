/**
 * Validación de adjuntos EN EL SERVIDOR, sin confiar en el nombre ni en el
 * Content-Type que declara el navegador:
 *  - formato real por la firma de bytes;
 *  - tamaño, dimensiones (imagen) y duración (audio) leídas del propio
 *    contenedor;
 *  - imágenes: se ELIMINAN metadatos (EXIF con GPS, XMP, comentarios) antes de
 *    guardar.
 * Sin dependencias nativas: cabeceras JPEG/PNG/WebP y contenedores
 * WAV/Ogg/WebM/MP4 se leen a mano y con cotas (un archivo malformado se
 * rechaza, nunca se «arregla»).
 */

export type ImageMime = 'image/jpeg' | 'image/png' | 'image/webp';
export type AudioMime = 'audio/webm' | 'audio/ogg' | 'audio/mp4' | 'audio/wav';

export class MediaRejectedError extends Error {
  constructor(
    readonly reason:
      | 'unsupported_format'
      | 'too_large'
      | 'too_many_pixels'
      | 'too_long'
      | 'empty'
      | 'malformed'
      | 'duration_unknown'
  ) {
    super(`media rejected: ${reason}`);
    this.name = new.target.name;
  }
}

export function sniffImage(b: Buffer): ImageMime | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png';
  if (
    b.length >= 12 &&
    b.toString('ascii', 0, 4) === 'RIFF' &&
    b.toString('ascii', 8, 12) === 'WEBP'
  )
    return 'image/webp';
  return null;
}

export function sniffAudio(b: Buffer): AudioMime | null {
  if (b.length >= 4 && b.readUInt32BE(0) === 0x1a45dfa3) return 'audio/webm';
  if (b.length >= 4 && b.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg';
  if (b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp') return 'audio/mp4';
  if (
    b.length >= 12 &&
    b.toString('ascii', 0, 4) === 'RIFF' &&
    b.toString('ascii', 8, 12) === 'WAVE'
  )
    return 'audio/wav';
  return null;
}

// ── Imágenes ────────────────────────────────────────────────────────────────

export interface ImageInfo {
  mime: ImageMime;
  width: number;
  height: number;
  /** Bytes a guardar: el original SIN metadatos. */
  clean: Buffer;
}

export function inspectImage(
  b: Buffer,
  limits: { maxBytes: number; maxPixels: number }
): ImageInfo {
  if (b.length === 0) throw new MediaRejectedError('empty');
  if (b.length > limits.maxBytes) throw new MediaRejectedError('too_large');
  const mime = sniffImage(b);
  if (!mime) throw new MediaRejectedError('unsupported_format');
  const r = mime === 'image/jpeg' ? jpeg(b) : mime === 'image/png' ? png(b) : webp(b);
  if (r.width <= 0 || r.height <= 0) throw new MediaRejectedError('malformed');
  if (r.width * r.height > limits.maxPixels) throw new MediaRejectedError('too_many_pixels');
  return { mime, width: r.width, height: r.height, clean: r.clean };
}

/** JPEG: recorre segmentos; conserva SOF/DQT/DHT/SOS…, descarta APP1–APP15 y COM. */
function jpeg(b: Buffer): { width: number; height: number; clean: Buffer } {
  const out: Buffer[] = [b.subarray(0, 2)];
  let i = 2;
  let w = 0;
  let h = 0;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) throw new MediaRejectedError('malformed');
    const marker = b[i + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      out.push(b.subarray(i, i + 2));
      i += 2;
      continue;
    }
    const len = b.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > b.length) throw new MediaRejectedError('malformed');
    const seg = b.subarray(i, i + 2 + len);
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      h = b.readUInt16BE(i + 5);
      w = b.readUInt16BE(i + 7);
    }
    const drop = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
    if (!drop) out.push(seg);
    if (marker === 0xda) {
      // Inicio de datos: el resto (datos comprimidos + EOI) se copia tal cual.
      out.push(b.subarray(i + 2 + len));
      return { width: w, height: h, clean: Buffer.concat(out) };
    }
    i += 2 + len;
  }
  throw new MediaRejectedError('malformed');
}

/** PNG: valida IHDR y descarta tEXt/zTXt/iTXt/eXIf/tIME. */
function png(b: Buffer): { width: number; height: number; clean: Buffer } {
  const out: Buffer[] = [b.subarray(0, 8)];
  let i = 8;
  let w = 0;
  let h = 0;
  let sawEnd = false;
  while (i + 12 <= b.length) {
    const len = b.readUInt32BE(i);
    const type = b.toString('ascii', i + 4, i + 8);
    if (i + 12 + len > b.length) throw new MediaRejectedError('malformed');
    if (type === 'IHDR') {
      w = b.readUInt32BE(i + 8);
      h = b.readUInt32BE(i + 12);
    }
    if (!['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME'].includes(type)) {
      out.push(b.subarray(i, i + 12 + len));
    }
    i += 12 + len;
    if (type === 'IEND') {
      sawEnd = true;
      break;
    }
  }
  if (!sawEnd) throw new MediaRejectedError('malformed');
  return { width: w, height: h, clean: Buffer.concat(out) };
}

/** WebP: lee VP8/VP8L/VP8X y descarta los fragmentos EXIF y XMP. */
function webp(b: Buffer): { width: number; height: number; clean: Buffer } {
  const chunks: Buffer[] = [];
  let i = 12;
  let w = 0;
  let h = 0;
  let vp8x: Buffer | null = null;
  while (i + 8 <= b.length) {
    const tag = b.toString('ascii', i, i + 4);
    const len = b.readUInt32LE(i + 4);
    const total = 8 + len + (len % 2);
    if (i + 8 + len > b.length) throw new MediaRejectedError('malformed');
    const body = b.subarray(i + 8, i + 8 + len);
    if (tag === 'VP8X' && len >= 10) {
      w = 1 + body.readUIntLE(4, 3);
      h = 1 + body.readUIntLE(7, 3);
    } else if (tag === 'VP8 ' && len >= 10 && !w) {
      w = body.readUInt16LE(6) & 0x3fff;
      h = body.readUInt16LE(8) & 0x3fff;
    } else if (tag === 'VP8L' && len >= 5 && !w) {
      const bits = body.readUInt32LE(1);
      w = (bits & 0x3fff) + 1;
      h = ((bits >> 14) & 0x3fff) + 1;
    }
    if (tag !== 'EXIF' && tag !== 'XMP ') {
      const chunk = Buffer.from(b.subarray(i, i + Math.min(total, b.length - i)));
      if (tag === 'VP8X') vp8x = chunk;
      chunks.push(chunk);
    }
    i += total;
  }
  if (vp8x) vp8x[8] = vp8x[8]! & ~0x0c; // flags EXIF (0x08) y XMP (0x04) apagados
  const payload = Buffer.concat(chunks);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(payload.length + 4, 4);
  head.write('WEBP', 8, 'ascii');
  return { width: w, height: h, clean: Buffer.concat([head, payload]) };
}

// ── Audio ───────────────────────────────────────────────────────────────────

export interface AudioInfo {
  mime: AudioMime;
  durationMs: number;
}

export function inspectAudio(
  b: Buffer,
  limits: { maxBytes: number; maxSeconds: number }
): AudioInfo {
  if (b.length === 0) throw new MediaRejectedError('empty');
  if (b.length > limits.maxBytes) throw new MediaRejectedError('too_large');
  const mime = sniffAudio(b);
  if (!mime) throw new MediaRejectedError('unsupported_format');
  const ms =
    mime === 'audio/wav'
      ? wavDuration(b)
      : mime === 'audio/ogg'
        ? oggDuration(b)
        : mime === 'audio/webm'
          ? webmDuration(b)
          : mp4Duration(b);
  if (ms === null || !Number.isFinite(ms) || ms < 0) throw new MediaRejectedError('malformed');
  // Duración desconocida (0 en un contenedor con audio) NUNCA se acepta como
  // ilimitada: se rechaza con un motivo propio.
  if (ms === 0) throw new MediaRejectedError('duration_unknown');
  if (ms > limits.maxSeconds * 1000) throw new MediaRejectedError('too_long');
  return { mime, durationMs: Math.round(ms) };
}

function wavDuration(b: Buffer): number | null {
  let i = 12;
  let byteRate = 0;
  while (i + 8 <= b.length) {
    const id = b.toString('ascii', i, i + 4);
    const len = b.readUInt32LE(i + 4);
    if (id === 'fmt ' && len >= 16) byteRate = b.readUInt32LE(i + 16);
    if (id === 'data') {
      if (!byteRate) return null;
      const dataLen = Math.min(len, b.length - i - 8);
      return (dataLen / byteRate) * 1000;
    }
    i += 8 + len + (len % 2);
  }
  return null;
}

/** Ogg/Opus o Vorbis: granule position de la ÚLTIMA página / frecuencia. */
function oggDuration(b: Buffer): number | null {
  let rate = 48_000; // Opus siempre usa 48 kHz en granule
  const vorbis = b.indexOf('\x01vorbis', 0, 'latin1');
  if (vorbis > 0 && vorbis + 16 <= b.length) rate = b.readUInt32LE(vorbis + 12);
  const opusHead = b.indexOf('OpusHead', 0, 'ascii');
  let preSkip = 0;
  if (opusHead > 0 && opusHead + 12 <= b.length) preSkip = b.readUInt16LE(opusHead + 10);
  for (let i = b.length - 14; i >= 0; i--) {
    if (b[i] === 0x4f && b.toString('ascii', i, i + 4) === 'OggS') {
      const granule = Number(b.readBigUInt64LE(i + 6));
      if (!rate) return null;
      return (Math.max(granule - preSkip, 0) / rate) * 1000;
    }
  }
  return null;
}

/** Lee un entero de tamaño variable EBML. */
function vint(b: Buffer, i: number, keepMarker: boolean): { value: number; len: number } | null {
  const first = b[i];
  if (first === undefined || first === 0) return null;
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 8 || i + len > b.length) return null;
  let value = keepMarker ? first : first & (0xff >> len);
  for (let k = 1; k < len; k++) value = value * 256 + b[i + k]!;
  // tamaño «desconocido» (todos los bits a 1)
  if (!keepMarker && value === 2 ** (7 * len) - 1) value = -1;
  return { value, len };
}

/**
 * WebM (MediaRecorder): la cabecera suele no traer Duration y Segment/Cluster
 * llegan con tamaño «desconocido». Se recorre LINEALMENTE (los contenedores
 * se abren en el mismo nivel, sin recursión) y se toma el mayor tiempo de
 * bloque (Cluster.Timecode + SimpleBlock relativo) × TimecodeScale.
 */
function webmDuration(b: Buffer): number | null {
  const CONTAINERS = new Set([0x18538067, 0x1f43b675, 0x1549a966, 0xa0]); // Segment, Cluster, Info, BlockGroup
  let scale = 1_000_000; // ns por tick (por defecto 1 ms)
  let declared: number | null = null;
  let maxTicks = 0;
  let clusterTc = 0;
  let i = 0;
  let guard = 0;
  while (i < b.length && guard++ < 1_000_000) {
    const id = vint(b, i, true);
    if (!id) break;
    const size = vint(b, i + id.len, false);
    if (!size) break;
    const body = i + id.len + size.len;
    if (CONTAINERS.has(id.value)) {
      i = body; // abrir el contenedor en el mismo nivel
      continue;
    }
    if (size.value < 0 || body + size.value > b.length) break;
    switch (id.value) {
      case 0x2ad7b1: // TimecodeScale
        scale = b.readUIntBE(body, Math.min(Math.max(size.value, 1), 6));
        break;
      case 0x4489: // Duration (float, en ticks)
        declared = size.value === 4 ? b.readFloatBE(body) : b.readDoubleBE(body);
        break;
      case 0xe7: // Cluster Timecode
        clusterTc = b.readUIntBE(body, Math.min(Math.max(size.value, 1), 6));
        break;
      case 0xa3: // SimpleBlock
      case 0xa1: {
        // Block: track (vint) + timecode relativo int16
        const tr = vint(b, body, false);
        if (tr && body + tr.len + 2 <= b.length) {
          maxTicks = Math.max(maxTicks, clusterTc + b.readInt16BE(body + tr.len));
        }
        break;
      }
      default:
        break;
    }
    i = body + size.value;
  }
  const ticks = declared !== null && declared > 0 ? declared : maxTicks;
  return (ticks * scale) / 1_000_000;
}

/**
 * MP4/M4A. Con `moov/mvhd` completo: duración / escala. En MP4 FRAGMENTADO
 * (MediaRecorder de Safari) `mvhd` suele traer 0: se suman las duraciones de
 * muestra de cada `moof/traf/trun` (o la duración por defecto de `tfhd`/`trex`)
 * con la escala de `mdhd`. Si nada de eso existe, la duración es desconocida.
 */
function mp4Duration(b: Buffer): number | null {
  interface Box {
    type: string;
    start: number; // inicio del contenido (tras la cabecera)
    end: number;
  }
  const children = (start: number, end: number): Box[] | null => {
    const out: Box[] = [];
    let i = start;
    while (i + 8 <= end) {
      let size = b.readUInt32BE(i);
      const type = b.toString('ascii', i + 4, i + 8);
      let header = 8;
      if (size === 1) {
        if (i + 16 > end) return null;
        size = Number(b.readBigUInt64BE(i + 8));
        header = 16;
      } else if (size === 0) size = end - i;
      if (size < header || i + size > end) return null;
      out.push({ type, start: i + header, end: i + size });
      i += size;
    }
    return out;
  };
  const find = (list: Box[] | null, type: string) => list?.find((x) => x.type === type) ?? null;
  const top = children(0, b.length);
  if (!top) return null;
  const moov = find(top, 'moov');
  if (!moov) return null;
  const moovKids = children(moov.start, moov.end);
  const mvhd = find(moovKids, 'mvhd');
  if (!mvhd || mvhd.start + 24 > b.length) return null;
  const v = b[mvhd.start]!;
  const mvTs = v === 1 ? b.readUInt32BE(mvhd.start + 20) : b.readUInt32BE(mvhd.start + 12);
  const mvDur =
    v === 1 ? Number(b.readBigUInt64BE(mvhd.start + 24)) : b.readUInt32BE(mvhd.start + 16);
  if (mvTs && mvDur) return (mvDur / mvTs) * 1000;

  // ── Fragmentado ──
  const trak = find(moovKids, 'trak');
  const mdia = trak ? find(children(trak.start, trak.end), 'mdia') : null;
  const mdhd = mdia ? find(children(mdia.start, mdia.end), 'mdhd') : null;
  if (!mdhd) return 0;
  const mv = b[mdhd.start]!;
  const timescale = mv === 1 ? b.readUInt32BE(mdhd.start + 20) : b.readUInt32BE(mdhd.start + 12);
  if (!timescale) return null;
  let trexDefault = 0;
  const mvex = find(moovKids, 'mvex');
  const trex = mvex ? find(children(mvex.start, mvex.end), 'trex') : null;
  if (trex && trex.start + 20 <= trex.end) trexDefault = b.readUInt32BE(trex.start + 12);

  let ticks = 0;
  for (const moof of top.filter((x) => x.type === 'moof')) {
    for (const traf of (children(moof.start, moof.end) ?? []).filter((x) => x.type === 'traf')) {
      const kids = children(traf.start, traf.end) ?? [];
      let def = trexDefault;
      const tfhd = find(kids, 'tfhd');
      if (tfhd) {
        const flags = b.readUInt32BE(tfhd.start) & 0xffffff;
        let o = tfhd.start + 8; // versión/flags + track_ID
        if (flags & 0x1) o += 8; // base_data_offset
        if (flags & 0x2) o += 4; // sample_description_index
        if (flags & 0x8 && o + 4 <= tfhd.end) def = b.readUInt32BE(o);
      }
      for (const trun of kids.filter((x) => x.type === 'trun')) {
        const flags = b.readUInt32BE(trun.start) & 0xffffff;
        const count = b.readUInt32BE(trun.start + 4);
        let o = trun.start + 8;
        if (flags & 0x1) o += 4; // data_offset
        if (flags & 0x4) o += 4; // first_sample_flags
        const per =
          (flags & 0x100 ? 4 : 0) +
          (flags & 0x200 ? 4 : 0) +
          (flags & 0x400 ? 4 : 0) +
          (flags & 0x800 ? 4 : 0);
        if (!(flags & 0x100)) {
          ticks += count * def;
          continue;
        }
        for (let k = 0; k < count && o + 4 <= trun.end; k++, o += per) ticks += b.readUInt32BE(o);
      }
    }
  }
  return (ticks / timescale) * 1000;
}
