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
      'unsupported_format' | 'too_large' | 'too_many_pixels' | 'too_long' | 'empty' | 'malformed'
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
 * WebM (MediaRecorder): la cabecera suele no traer Duration; se toma el mayor
 * tiempo de bloque (Cluster.Timecode + SimpleBlock relativo) × TimecodeScale.
 */
function webmDuration(b: Buffer): number | null {
  const SEGMENT = 0x18538067;
  const CLUSTER = 0x1f43b675;
  const INFO = 0x1549a966;
  let scale = 1_000_000; // ns por tick (por defecto 1 ms)
  let declared: number | null = null;
  let maxTicks = 0;
  let clusterTc = 0;
  const walk = (start: number, end: number, depth: number) => {
    let i = start;
    while (i < end && depth < 5) {
      const id = vint(b, i, true);
      if (!id) return;
      const size = vint(b, i + id.len, false);
      if (!size) return;
      const body = i + id.len + size.len;
      const stop = size.value < 0 ? end : Math.min(body + size.value, end);
      switch (id.value) {
        case SEGMENT:
        case CLUSTER:
        case INFO:
          walk(body, stop, depth + 1);
          break;
        case 0x2ad7b1: // TimecodeScale
          scale = b.readUIntBE(body, Math.min(size.value, 6));
          break;
        case 0x4489: // Duration (float, en ticks)
          declared = size.value === 4 ? b.readFloatBE(body) : b.readDoubleBE(body);
          break;
        case 0xe7: // Cluster Timecode
          clusterTc = b.readUIntBE(body, Math.min(Math.max(size.value, 1), 6));
          break;
        case 0xa3: {
          // SimpleBlock: track (vint) + timecode relativo int16
          const tr = vint(b, body, false);
          if (tr && body + tr.len + 2 <= b.length) {
            maxTicks = Math.max(maxTicks, clusterTc + b.readInt16BE(body + tr.len));
          }
          break;
        }
        default:
          break;
      }
      if (size.value < 0 && id.value !== SEGMENT && id.value !== CLUSTER) return;
      i = stop;
    }
  };
  walk(0, b.length, 0);
  const ticks = declared !== null && declared > 0 ? declared : maxTicks;
  return (ticks * scale) / 1_000_000;
}

/** MP4/M4A: moov → mvhd (duration / timescale). */
function mp4Duration(b: Buffer): number | null {
  const find = (start: number, end: number, path: string[]): number | null => {
    let i = start;
    while (i + 8 <= end) {
      let size = b.readUInt32BE(i);
      const type = b.toString('ascii', i + 4, i + 8);
      let header = 8;
      if (size === 1 && i + 16 <= end) {
        size = Number(b.readBigUInt64BE(i + 8));
        header = 16;
      } else if (size === 0) size = end - i;
      if (size < header || i + size > end) return null;
      if (type === path[0]) {
        if (path.length === 1) return i + header;
        return find(i + header, i + size, path.slice(1));
      }
      i += size;
    }
    return null;
  };
  const m = find(0, b.length, ['moov', 'mvhd']);
  if (m === null || m + 32 > b.length) return null;
  const version = b[m]!;
  if (version === 1) {
    const ts = b.readUInt32BE(m + 20);
    const dur = Number(b.readBigUInt64BE(m + 24));
    return ts ? (dur / ts) * 1000 : null;
  }
  const ts = b.readUInt32BE(m + 12);
  const dur = b.readUInt32BE(m + 16);
  return ts ? (dur / ts) * 1000 : null;
}
