'use client';

import { useEffect, useRef, useState } from 'react';
import { Icon } from './icons';
import { assistantError, call, upload } from './sse';

/** Formato que el navegador sabe grabar y el servidor sabe validar. */
export function recorderMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  for (const m of ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm']) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return undefined;
}

type State = 'idle' | 'asking' | 'recording' | 'recorded' | 'sending' | 'denied' | 'unsupported';

/**
 * Nota de voz: grabar → detener → escuchar → borrar o transcribir. La
 * transcripción vuelve al cuadro de texto para que la persona la REVISE antes
 * de enviarla. El micrófono se libera al detener, al borrar y al desmontar.
 */
export function VoiceNote({
  base,
  maxSeconds,
  simulated,
  onTranscript,
}: {
  base: string;
  maxSeconds: number;
  simulated: boolean;
  onTranscript: (text: string) => void;
}) {
  const [state, setState] = useState<State>('idle');
  const [seconds, setSeconds] = useState(0);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const blob = useRef<Blob | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const release = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  useEffect(
    () => () => {
      if (rec.current?.state === 'recording') rec.current.stop();
      release();
    },
    []
  );
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);

  const start = async () => {
    setError(null);
    const mime = recorderMime();
    if (!mime || !navigator.mediaDevices?.getUserMedia) {
      setState('unsupported');
      return;
    }
    setState('asking');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setState('denied');
      return;
    }
    streamRef.current = stream;
    chunks.current = [];
    const r = new MediaRecorder(stream, { mimeType: mime });
    r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
    r.onstop = () => {
      release();
      blob.current = new Blob(chunks.current, { type: mime.split(';')[0] });
      setUrl(URL.createObjectURL(blob.current));
      setState('recorded');
    };
    rec.current = r;
    r.start(250);
    setSeconds(0);
    setState('recording');
    timer.current = setInterval(() => {
      setSeconds((s) => {
        if (s + 1 >= maxSeconds) r.stop();
        return s + 1;
      });
    }, 1000);
  };

  const stop = () => rec.current?.state === 'recording' && rec.current.stop();

  const discard = () => {
    blob.current = null;
    if (url) URL.revokeObjectURL(url);
    setUrl(null);
    setState('idle');
  };

  const transcribe = async () => {
    if (!blob.current) return;
    setState('sending');
    const up = await upload(`${base}/attachments`, 'audio', blob.current, () => undefined);
    if (!up.ok) {
      setError(assistantError(up.status, up.code));
      setState('recorded');
      return;
    }
    const t = await call<{ text: string }>(`${base}/transcriptions`, {
      method: 'POST',
      json: { attachment_id: up.body.id },
    });
    if (!t.ok) {
      setError(assistantError(t.status, t.code));
      setState('recorded');
      return;
    }
    onTranscript(t.body.text);
    discard();
  };

  if (state === 'recording') {
    return (
      <span className="as-voice" role="group" aria-label="Grabando nota de voz">
        <span className="as-rec-dot" aria-hidden="true" />
        <span aria-live="off">
          {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
        </span>
        <button type="button" className="as-btn" onClick={stop}>
          <Icon name="stop" /> Detener
        </button>
      </span>
    );
  }
  if (state === 'recorded' || state === 'sending') {
    return (
      <span className="as-voice" role="group" aria-label="Nota de voz grabada">
        {url ? <audio controls src={url} aria-label="Escuchar tu nota de voz" /> : null}
        <button
          type="button"
          className="as-icon-btn"
          onClick={discard}
          disabled={state === 'sending'}
        >
          <Icon name="trash" />
          <span className="sr-only">Borrar nota de voz</span>
        </button>
        <button
          type="button"
          className="as-btn"
          onClick={() => void transcribe()}
          disabled={state === 'sending'}
        >
          {state === 'sending'
            ? 'Transcribiendo…'
            : simulated
              ? 'Transcribir (simulado)'
              : 'Transcribir'}
        </button>
        {error ? (
          <span className="as-error" role="alert">
            {error}
          </span>
        ) : null}
      </span>
    );
  }
  return (
    <>
      <button
        type="button"
        className="as-icon-btn"
        onClick={() => void start()}
        disabled={state === 'asking'}
        aria-describedby={state === 'denied' || state === 'unsupported' ? 'as-mic-msg' : undefined}
      >
        <Icon name="mic" />
        <span className="sr-only">Grabar nota de voz</span>
      </button>
      {state === 'denied' ? (
        <span id="as-mic-msg" className="as-error" role="alert">
          Permiso de micrófono denegado. Actívalo en tu navegador o escribe tu mensaje.
        </span>
      ) : state === 'unsupported' ? (
        <span id="as-mic-msg" className="as-error" role="alert">
          Este navegador no puede grabar audio. Escribe tu mensaje.
        </span>
      ) : null}
    </>
  );
}
