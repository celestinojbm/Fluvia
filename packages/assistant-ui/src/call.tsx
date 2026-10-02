'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from './csrf-header';
import { Icon } from './icons';
import { assistantError, call, upload } from './sse';
import { recorderMime } from './voice-note';
import { WebRtcCallPanel } from './call-webrtc';

/**
 * «Hablar con Fluvia» — llamada de voz.
 *
 * Con transporte SIMULADO (sin servidor de medios) la llamada es LOCAL: el
 * micrófono es real, la detección de voz y la interrupción (barge-in) son
 * reales en el navegador, y cada turno pasa por las MISMAS rutas que el chat
 * (nota → transcripción → asistente → voz). La UI dice «simulada» en todo
 * momento; no se afirma una llamada real.
 *
 * Esto NO es una llamada WebRTC: es el modo local para cuando no hay servidor
 * de llamadas. Con transporte LiveKit configurado se usa `WebRtcCallPanel`
 * (call-webrtc.tsx): sala propia, agente de voz y audio por WebRTC.
 *
 * Siempre: consentimiento explícito antes de pedir el micrófono; silencio,
 * colgar y selección de dispositivo; cámara/pantalla solo voluntarias y
 * revocables; recursos liberados al colgar, cerrar o salir.
 */

type CallState =
  'consent' | 'connecting' | 'connected' | 'reconnecting' | 'ended' | 'denied' | 'error';

interface Line {
  who: 'tú' | 'fluvia' | 'sistema';
  text: string;
}

const SPEECH_LEVEL = 0.06;
const SILENCE_MS = 900;
const MIN_SPEECH_MS = 250;

interface CallProps {
  base: string;
  /** Envía el turno a la conversación (modo llamada) y devuelve la respuesta. */
  onAsk: (text: string, attachmentIds: string[]) => Promise<string | null>;
  onClose: () => void;
}

export function CallPanel({ simulated, ...props }: CallProps & { simulated: boolean }) {
  return simulated ? <LocalSimulatedCall {...props} /> : <WebRtcCallPanel {...props} />;
}

function LocalSimulatedCall({ base, onAsk, onClose }: CallProps) {
  const [state, setState] = useState<CallState>('consent');
  const [muted, setMuted] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string>('');
  const [lines, setLines] = useState<Line[]>([]);
  const [level, setLevel] = useState(0);
  const [agentSpeaking, setAgentSpeaking] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [maxSeconds, setMaxSeconds] = useState(600);
  const [sharing, setSharing] = useState<'screen' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const stream = useRef<MediaStream | null>(null);
  const screen = useRef<MediaStream | null>(null);
  const screenVideo = useRef<HTMLVideoElement>(null);
  const ctx = useRef<AudioContext | null>(null);
  const raf = useRef<number | null>(null);
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const speechStart = useRef<number | null>(null);
  const lastVoice = useRef(0);
  const agentAudio = useRef<HTMLAudioElement | null>(null);
  const busyTurn = useRef(false);
  const mutedRef = useRef(false);
  const live = useRef(false);

  const say = (who: Line['who'], text: string) => setLines((l) => [...l, { who, text }]);

  const stopAgent = () => {
    agentAudio.current?.pause();
    agentAudio.current = null;
    setAgentSpeaking(false);
  };

  const releaseAll = useCallback(() => {
    live.current = false;
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = null;
    if (tick.current) clearInterval(tick.current);
    tick.current = null;
    if (rec.current?.state === 'recording') rec.current.stop();
    rec.current = null;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    screen.current?.getTracks().forEach((t) => t.stop());
    screen.current = null;
    setSharing(null);
    void ctx.current?.close().catch(() => undefined);
    ctx.current = null;
    stopAgent();
  }, []);

  useEffect(() => releaseAll, [releaseAll]);

  // Red: «reconectando» mientras el navegador está sin conexión.
  useEffect(() => {
    const off = () => live.current && setState('reconnecting');
    const on = () => live.current && setState('connected');
    window.addEventListener('offline', off);
    window.addEventListener('online', on);
    return () => {
      window.removeEventListener('offline', off);
      window.removeEventListener('online', on);
    };
  }, []);

  const handleTurn = async (audio: Blob) => {
    if (busyTurn.current) return;
    busyTurn.current = true;
    try {
      const up = await upload(`${base}/attachments`, 'audio', audio, () => undefined);
      if (!up.ok) {
        say('sistema', assistantError(up.status, up.code));
        return;
      }
      const t = await call<{ text: string; simulated: boolean }>(`${base}/transcriptions`, {
        method: 'POST',
        json: { attachment_id: up.body.id },
      });
      if (!t.ok) {
        say('sistema', assistantError(t.status, t.code));
        return;
      }
      say('tú', t.body.text);
      const reply = await onAsk(t.body.text, []);
      if (!reply || !live.current) return;
      say('fluvia', reply);
      await speak(reply);
    } finally {
      busyTurn.current = false;
    }
  };

  const speak = async (text: string) => {
    const res = await fetch(`${base}/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [CSRF_HEADER]: CSRF_HEADER_VALUE },
      body: JSON.stringify({ text: text.slice(0, 1000) }),
    }).catch(() => null);
    if (!res?.ok || !live.current) return;
    const url = URL.createObjectURL(await res.blob());
    const a = new Audio(url);
    agentAudio.current = a;
    setAgentSpeaking(true);
    a.onended = () => {
      URL.revokeObjectURL(url);
      if (agentAudio.current === a) stopAgent();
    };
    await a.play().catch(() => stopAgent());
  };

  const loop = (analyser: AnalyserNode, buf: Float32Array<ArrayBuffer>) => {
    if (!live.current) return;
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    const rms = Math.sqrt(sum / buf.length);
    setLevel(rms);
    const now = performance.now();
    const speaking = !mutedRef.current && rms > SPEECH_LEVEL;
    if (speaking) {
      lastVoice.current = now;
      if (speechStart.current === null) speechStart.current = now;
      // Barge-in: si la persona habla mientras Fluvia habla, Fluvia calla.
      if (agentAudio.current && now - speechStart.current > MIN_SPEECH_MS) {
        stopAgent();
        say('sistema', 'Interrumpiste a Fluvia.');
      }
      if (!rec.current && stream.current && !busyTurn.current) {
        const mime = recorderMime();
        if (mime) {
          chunks.current = [];
          const r = new MediaRecorder(stream.current, { mimeType: mime });
          r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
          r.onstop = () => {
            const dur = (lastVoice.current - (speechStart.current ?? lastVoice.current)) | 0;
            speechStart.current = null;
            if (dur >= MIN_SPEECH_MS && live.current) {
              void handleTurn(new Blob(chunks.current, { type: mime.split(';')[0] }));
            }
          };
          rec.current = r;
          r.start(200);
        }
      }
    } else if (rec.current && now - lastVoice.current > SILENCE_MS) {
      const r = rec.current;
      rec.current = null;
      if (r.state === 'recording') r.stop();
    } else if (
      !rec.current &&
      speechStart.current !== null &&
      now - lastVoice.current > SILENCE_MS
    ) {
      speechStart.current = null;
    }
    raf.current = requestAnimationFrame(() => loop(analyser, buf));
  };

  const acquire = async (id: string) => {
    stream.current?.getTracks().forEach((t) => t.stop());
    const s = await navigator.mediaDevices.getUserMedia({
      audio: id ? { deviceId: { exact: id }, echoCancellation: true } : { echoCancellation: true },
    });
    s.getAudioTracks().forEach((t) => (t.enabled = !mutedRef.current));
    stream.current = s;
    if (!ctx.current) ctx.current = new AudioContext();
    const src = ctx.current.createMediaStreamSource(s);
    const analyser = ctx.current.createAnalyser();
    analyser.fftSize = 1024;
    src.connect(analyser);
    if (raf.current) cancelAnimationFrame(raf.current);
    loop(analyser, new Float32Array(new ArrayBuffer(analyser.fftSize * 4)));
  };

  const connect = async () => {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setState('error');
      setError('Este navegador no permite usar el micrófono. Sigue por chat.');
      return;
    }
    setState('connecting');
    try {
      await navigator.mediaDevices
        .getUserMedia({ audio: true })
        .then((s) => s.getTracks().forEach((t) => t.stop()));
    } catch {
      setState('denied');
      return;
    }
    const g = await call<{ simulated: boolean; url: string | null; max_seconds: number }>(
      `${base}/call/token`,
      { method: 'POST' }
    );
    if (!g.ok) {
      setState('error');
      setError(assistantError(g.status, g.code));
      return;
    }
    setMaxSeconds(g.body.max_seconds);
    live.current = true;
    try {
      await acquire(deviceId);
      const list = await navigator.mediaDevices.enumerateDevices();
      setDevices(list.filter((d) => d.kind === 'audioinput'));
    } catch {
      releaseAll();
      setState('denied');
      return;
    }
    setState('connected');
    setElapsed(0);
    say('sistema', 'Llamada simulada: tu voz se transcribe con el proveedor simulado.');
    tick.current = setInterval(() => setElapsed((s) => s + 1), 1000);
  };

  useEffect(() => {
    if (state === 'connected' && elapsed >= maxSeconds)
      hangUp('Se alcanzó la duración máxima de la llamada.');
  }, [elapsed, maxSeconds, state]);

  const hangUp = (reason?: string) => {
    releaseAll();
    if (reason) say('sistema', reason);
    setState('ended');
  };

  const toggleMute = () => {
    const m = !muted;
    setMuted(m);
    mutedRef.current = m;
    stream.current?.getAudioTracks().forEach((t) => (t.enabled = !m));
  };

  const changeDevice = async (id: string) => {
    setDeviceId(id);
    if (live.current) {
      try {
        await acquire(id);
      } catch {
        setError('No se pudo usar ese micrófono.');
      }
    }
  };

  const toggleScreen = async () => {
    if (screen.current) {
      screen.current.getTracks().forEach((t) => t.stop());
      screen.current = null;
      setSharing(null);
      return;
    }
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      screen.current = s;
      s.getVideoTracks()[0]!.onended = () => {
        screen.current = null;
        setSharing(null);
      };
      setSharing('screen');
      requestAnimationFrame(() => {
        if (screenVideo.current) screenVideo.current.srcObject = s;
      });
    } catch {
      setError('No se compartió la pantalla.');
    }
  };

  const sendPhoto = async (files: FileList | null) => {
    const f = files?.[0];
    if (!f) return;
    const up = await upload(`${base}/attachments`, 'image', f, () => undefined);
    if (!up.ok) {
      say('sistema', assistantError(up.status, up.code));
      return;
    }
    say('tú', '(Foto enviada)');
    const reply = await onAsk('', [String(up.body.id)]);
    if (reply && live.current) {
      say('fluvia', reply);
      await speak(reply);
    }
  };

  const mm = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  const STATE_LABEL: Record<CallState, string> = {
    consent: 'Sin conectar',
    connecting: 'Conectando…',
    connected: 'Conectada',
    reconnecting: 'Reconectando…',
    ended: 'Finalizada',
    denied: 'Micrófono denegado',
    error: 'Error',
  };

  return (
    <section
      className="as-body as-call"
      aria-labelledby="as-call-title"
      data-call-transport="local-simulated"
    >
      <h3 id="as-call-title">
        Hablar con Fluvia <span className="as-sim-chip">Llamada simulada · local, sin WebRTC</span>
      </h3>
      <p className="as-call-state" role="status" aria-live="polite">
        Estado: <strong>{STATE_LABEL[state]}</strong>
        {state === 'connected' || state === 'reconnecting'
          ? ` · ${mm(elapsed)} de ${mm(maxSeconds)}`
          : ''}
      </p>

      {state === 'consent' ? (
        <div className="as-call-consent">
          <p>
            Usaremos tu micrófono solo durante la llamada. Lo que digas se transcribe y queda en tu
            conversación con Fluvia. Puedes silenciarte o colgar en cualquier momento. No hay número
            de teléfono: la llamada es solo desde aquí.
          </p>
          <div className="as-call-actions">
            <button type="button" className="as-send" onClick={() => void connect()}>
              <Icon name="phone" /> Permitir micrófono y conectar
            </button>
            <button type="button" className="as-btn" onClick={onClose}>
              Seguir por chat
            </button>
          </div>
        </div>
      ) : null}

      {state === 'denied' ? (
        <div className="as-error" role="alert">
          <p>
            Sin permiso de micrófono no podemos llamar. Actívalo en tu navegador o sigue por chat.
          </p>
          <button type="button" className="as-btn" onClick={onClose}>
            Seguir por chat
          </button>
        </div>
      ) : null}

      {error ? (
        <p className="as-error" role="alert">
          {error}
        </p>
      ) : null}

      {state === 'connected' || state === 'reconnecting' ? (
        <>
          <div className="as-meter" aria-hidden="true">
            <span style={{ transform: `scaleX(${Math.min(1, level * 8)})` }} />
          </div>
          <p className="as-muted">
            {muted
              ? 'Micrófono silenciado.'
              : agentSpeaking
                ? 'Fluvia está hablando: puedes interrumpir.'
                : 'Te escucho.'}
          </p>
          <div className="as-call-actions">
            <button type="button" className="as-btn" onClick={toggleMute} aria-pressed={muted}>
              <Icon name={muted ? 'mic-off' : 'mic'} /> {muted ? 'Activar micrófono' : 'Silenciar'}
            </button>
            <label className="as-btn as-file">
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={(e) => void sendPhoto(e.target.files)}
              />
              <Icon name="camera" /> Enviar foto
            </label>
            <button
              type="button"
              className="as-btn"
              onClick={() => void toggleScreen()}
              aria-pressed={sharing === 'screen'}
            >
              <Icon name="screen" /> {sharing ? 'Dejar de compartir' : 'Compartir pantalla'}
            </button>
            <button type="button" className="as-hangup" onClick={() => hangUp()}>
              <Icon name="phone-off" /> Colgar
            </button>
          </div>
          {devices.length > 1 ? (
            <label className="as-field">
              Micrófono
              <select value={deviceId} onChange={(e) => void changeDevice(e.target.value)}>
                {devices.map((d, i) => (
                  <option key={d.deviceId || i} value={d.deviceId}>
                    {d.label || `Micrófono ${i + 1}`}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {sharing ? (
            <div className="as-share">
              <video
                ref={screenVideo}
                autoPlay
                muted
                playsInline
                aria-label="Vista previa de tu pantalla"
              />
              <p className="as-muted">
                Llamada simulada: tu pantalla no se envía a nadie, solo la ves tú.
              </p>
            </div>
          ) : null}
        </>
      ) : null}

      {lines.length ? (
        <ol className="as-transcript" aria-label="Transcripción en vivo" aria-live="polite">
          {lines.map((l, i) => (
            <li key={i} data-who={l.who}>
              <strong>{l.who === 'tú' ? 'Tú' : l.who === 'fluvia' ? 'Fluvia' : 'Aviso'}:</strong>{' '}
              {l.text}
            </li>
          ))}
        </ol>
      ) : null}

      {state === 'ended' ? (
        <div className="as-call-summary">
          <h4>Resumen de la llamada</h4>
          <p>
            Duración {mm(elapsed)} · {lines.filter((l) => l.who === 'tú').length} turno(s) tuyo(s) ·{' '}
            {lines.filter((l) => l.who === 'fluvia').length} respuesta(s). El micrófono quedó
            liberado y la conversación sigue en el chat.
          </p>
          <button type="button" className="as-send" onClick={onClose}>
            Volver al chat
          </button>
        </div>
      ) : null}
    </section>
  );
}
