import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../csrf-header';

/** Llamadas del navegador al BFF del asistente (con la cabecera anti-CSRF). */
export async function call<T>(
  url: string,
  init: { method?: 'GET' | 'POST'; json?: unknown } = {}
): Promise<{ ok: true; body: T } | { ok: false; status: number; code?: string }> {
  const method = init.method ?? 'GET';
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers:
        method === 'POST'
          ? {
              [CSRF_HEADER]: CSRF_HEADER_VALUE,
              ...(init.json === undefined ? {} : { 'content-type': 'application/json' }),
            }
          : {},
      body: init.json === undefined ? undefined : JSON.stringify(init.json),
      cache: 'no-store',
    });
  } catch {
    return { ok: false, status: 0 };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* sin JSON */
  }
  if (res.ok) return { ok: true, body: body as T };
  const code = (body as { error?: { code?: string } } | null)?.error?.code;
  return { ok: false, status: res.status, code };
}

/** Sube un adjunto con progreso (XHR: fetch no expone el progreso de subida). */
export function upload(
  url: string,
  kind: 'image' | 'audio',
  data: Blob,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal
): Promise<
  { ok: true; body: Record<string, unknown> } | { ok: false; status: number; code?: string }
> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.setRequestHeader('x-attachment-kind', kind);
    xhr.setRequestHeader(CSRF_HEADER, CSRF_HEADER_VALUE);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(xhr.responseText) as Record<string, unknown>;
      } catch {
        /* vacío */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve({ ok: true, body });
      else
        resolve({
          ok: false,
          status: xhr.status,
          code: (body.error as { code?: string } | undefined)?.code,
        });
    };
    xhr.onerror = () => resolve({ ok: false, status: 0 });
    xhr.onabort = () => resolve({ ok: false, status: 0, code: 'aborted' });
    signal?.addEventListener('abort', () => xhr.abort());
    xhr.send(data);
  });
}

/** Lee eventos SSE de una respuesta `fetch`. */
export async function* readSse(
  res: Response
): AsyncIterable<{ event: string; data: Record<string, unknown> }> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = /^event: (.*)$/m.exec(raw)?.[1] ?? 'message';
      const data = /^data: (.*)$/m.exec(raw)?.[1];
      if (!data) continue;
      try {
        yield { event: ev, data: JSON.parse(data) as Record<string, unknown> };
      } catch {
        /* evento malformado: se ignora */
      }
    }
  }
}

/** Texto para el usuario según el código de error del catálogo. */
export function assistantError(status: number, code?: string): string {
  if (status === 0) return 'Sin conexión con Fluvia. Revisa tu red y vuelve a intentarlo.';
  if (status === 401) return 'Tu sesión caducó. Vuelve a entrar para seguir.';
  switch (code) {
    case 'assistant_quota_exceeded':
      return 'Llegaste al límite de mensajes de hoy. Vuelve mañana o usa el centro de ayuda.';
    case 'assistant_busy':
      return 'Fluvia todavía está respondiendo. Espera o detén la respuesta.';
    case 'assistant_invalid_attachment':
      return 'Uno de los adjuntos ya no está disponible. Quítalo y vuelve a intentarlo.';
    case 'media_unsupported':
      return 'Formato no admitido. Usa una foto JPG, PNG o WebP.';
    case 'media_too_large':
      return 'El archivo es demasiado grande.';
    case 'media_too_long':
      return 'La nota de voz es demasiado larga.';
    case 'media_malformed':
      return 'El archivo está dañado o incompleto.';
    case 'assistant_provider_unavailable':
    case 'overloaded':
    case 'unavailable':
    case 'rate_limited':
      return 'Fluvia no está disponible en este momento. Vuelve a intentarlo en unos segundos.';
    default:
      return 'No se pudo completar. Vuelve a intentarlo.';
  }
}
