'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Room, RemoteTrack } from 'livekit-client';
import { Icon } from './icons';
import { assistantError, call, upload } from './sse';

/**
 * «Hablar con Fluvia» por WebRTC (LiveKit).
 *
 * Flujo: consentimiento → la API despacha al agente de voz a una sala propia y
 * devuelve un token de vida corta (solo micrófono) → el navegador entra en la
 * sala, publica el micrófono y escucha al agente. El agente transcribe cada
 * turno y lo envía por el canal de datos; el panel lo pasa a la MISMA
 * conversación del chat (modo «llamada», herramientas de solo lectura con la
 * sesión de la persona) y manda la respuesta al agente para que la diga.
 *
 * El agente no tiene credenciales de Fluvia: solo oye, transcribe y habla.
 * Si el agente es de PRUEBA (sin STT/TTS reales) la UI lo dice siempre.
 */

const TOPIC = 'fluvia-call';
const AGENT = 'agente-fluvia';
const AGENT_JOIN_MS = 15_000;
const AGENT_LEFT_GRACE_MS = 5_000;
const BYE_WAIT_MS = 2_000;

type State = 'consent' | 'connecting' | 'connected' | 'reconnecting' | 'ended' | 'denied' | 'error';

interface Line {
  who: 'tú' | 'fluvia' | 'sistema';
  text: string;
}

type AgentMsg =
  | {
      t: 'hello';
      test: boolean;
      stt: { provider: string; simulated: boolean };
      tts: { provider: string; simulated: boolean };
      maxSeconds: number;
    }
  | { t: 'speech_start' }
  | { t: 'transcript'; text: string; seconds: number; simulated: boolean }
  | { t: 'speaking'; on: boolean }
  | { t: 'interrupted' }
  | { t: 'error'; code: string };

const AGENT_ERRORS: Record<string, string> = {
  stt_failed: 'No se pudo transcribir ese turno. Repítelo, por favor.',
  tts_failed: 'Fluvia no pudo decir la respuesta; la tienes por escrito.',
  max_duration: 'Se alcanzó la duración máxima de la llamada.',
};

export function WebRtcCallPanel({
  base,
  onAsk,
  onClose,
}: {
  base: string;
  onAsk: (text: string, attachmentIds: string[]) => Promise<string | null>;
  onClose: () => void;
}) {
  const [state, setState] = useState<State>('consent');
  const [muted, setMuted] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [agent, setAgent] = useState<Extract<AgentMsg, { t: 'hello' }> | null>(null);
  const [agentSpeaking, setAgentSpeaking] = useState(false);
  const [agentLevel, setAgentLevel] = useState(0);
  const [heardAgent, setHeardAgent] = useState(false);
  const [needsAudioUnlock, setNeedsAudioUnlock] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [maxSeconds, setMaxSeconds] = useState(600);
  const [error, setError] = useState<string | null>(null);
  const [thinking, setThinking] = useState(false);

  const room = useRef<Room | null>(null);
  const audioEls = useRef<HTMLMediaElement[]>([]);
  const ctx = useRef<AudioContext | null>(null);
  const raf = useRef<number | null>(null);
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);
  const agentTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const turns = useRef<Promise<void>>(Promise.resolve());
  const live = useRef(false);
  const greeted = useRef(false);

  const say = (who: Line['who'], text: string) => setLines((l) => [...l, { who, text }]);

  const release = useCallback(async () => {
    live.current = false;
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = null;
    if (tick.current) clearInterval(tick.current);
    tick.current = null;
    if (agentTimer.current) clearTimeout(agentTimer.current);
    agentTimer.current = null;
    audioEls.current.forEach((el) => el.remove());
    audioEls.current = [];
    const r = room.current;
    room.current = null;
    // disconnect() detiene y libera las pistas locales (micrófono).
    if (r) await r.disconnect(true).catch(() => undefined);
    await ctx.current?.close().catch(() => undefined);
    ctx.current = null;
    setAgentSpeaking(false);
  }, []);

  useEffect(
    () => () => {
      void release();
    },
    [release]
  );

  const hangUp = useCallback(
    async (reason?: string) => {
      const r = room.current;
      // Desde aquí la salida de Fluvia es la esperada, no un aviso.
      live.current = false;
      if (r?.localParticipant && r.getParticipantByIdentity(AGENT)) {
        await r.localParticipant
          .publishData(new TextEncoder().encode(JSON.stringify({ t: 'bye' })), {
            reliable: true,
            topic: TOPIC,
            destinationIdentities: [AGENT],
          })
          .catch(() => undefined);
        // Se mantiene la conexión hasta que Fluvia sale (máx. 2 s): si se
        // cortara enseguida, el «bye» podría perderse y el agente esperaría
        // el margen de reconexión ocupando la sala.
        const end = Date.now() + BYE_WAIT_MS;
        while (r.getParticipantByIdentity(AGENT) && Date.now() < end) {
          await new Promise((ok) => setTimeout(ok, 50));
        }
      }
      await release();
      if (reason) say('sistema', reason);
      setState('ended');
    },
    [release]
  );

  useEffect(() => {
    if (state === 'connected' && elapsed >= maxSeconds)
      void hangUp('Se alcanzó la duración máxima de la llamada.');
  }, [elapsed, maxSeconds, state, hangUp]);

  const sendToAgent = async (text: string) => {
    const r = room.current;
    if (!r || !live.current) return;
    await r.localParticipant
      .publishData(
        new TextEncoder().encode(JSON.stringify({ t: 'say', text: text.slice(0, 1000) })),
        {
          reliable: true,
          topic: TOPIC,
          destinationIdentities: [AGENT],
        }
      )
      .catch(() => say('sistema', 'No se pudo enviar la respuesta a la voz de Fluvia.'));
  };

  // Un turno a la vez: transcripción → conversación → voz.
  const ask = (text: string, ids: string[]) => {
    turns.current = turns.current.then(async () => {
      if (!live.current) return;
      setThinking(true);
      try {
        const reply = await onAsk(text, ids);
        if (!reply || !live.current) return;
        say('fluvia', reply);
        await sendToAgent(reply);
      } finally {
        setThinking(false);
      }
    });
  };

  const onAgentMessage = (m: AgentMsg) => {
    switch (m.t) {
      case 'hello':
        greeted.current = true;
        if (agentTimer.current) clearTimeout(agentTimer.current);
        agentTimer.current = null;
        setAgent(m);
        setMaxSeconds((s) => Math.min(s, m.maxSeconds));
        say(
          'sistema',
          m.test
            ? 'Conectada por WebRTC con el agente de PRUEBA: el audio es real, la transcripción y la voz son de prueba.'
            : 'Conectada por WebRTC con Fluvia.'
        );
        break;
      case 'transcript':
        say('tú', m.text);
        ask(m.text, []);
        break;
      case 'speaking':
        setAgentSpeaking(m.on);
        break;
      case 'interrupted':
        setAgentSpeaking(false);
        say('sistema', 'Interrumpiste a Fluvia.');
        break;
      case 'error':
        if (m.code === 'max_duration') void hangUp(AGENT_ERRORS.max_duration);
        else say('sistema', AGENT_ERRORS[m.code] ?? 'Fluvia tuvo un problema con la llamada.');
        break;
      default:
        break;
    }
  };

  const meterAgent = (track: RemoteTrack) => {
    const c = ctx.current;
    if (!c) return;
    const src = c.createMediaStreamSource(new MediaStream([track.mediaStreamTrack]));
    const an = c.createAnalyser();
    an.fftSize = 1024;
    src.connect(an);
    const buf = new Float32Array(new ArrayBuffer(an.fftSize * 4));
    const loop = () => {
      if (!live.current) return;
      an.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      const rms = Math.sqrt(sum / buf.length);
      setAgentLevel(rms);
      if (rms > 0.02) setHeardAgent(true);
      raf.current = requestAnimationFrame(loop);
    };
    loop();
  };

  const connect = async () => {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === 'undefined') {
      setState('error');
      setError('Este navegador no permite llamadas. Sigue por chat.');
      return;
    }
    setState('connecting');
    // Permiso de micrófono ANTES de pedir sala y agente: si se deniega, no se
    // despacha a nadie ni se abre conexión.
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
      probe.getTracks().forEach((t) => t.stop());
    } catch {
      setState('denied');
      return;
    }
    // El AudioContext se crea dentro del clic (políticas de reproducción).
    ctx.current = new AudioContext();
    const g = await call<{
      simulated: boolean;
      url: string | null;
      token: string;
      max_seconds: number;
    }>(`${base}/call/token`, { method: 'POST' });
    if (!g.ok || !g.body.url) {
      await release();
      setState('error');
      setError(
        g.ok ? 'El servidor de llamadas no está configurado.' : assistantError(g.status, g.code)
      );
      return;
    }
    setMaxSeconds(g.body.max_seconds);
    const lk = await import('livekit-client');
    const r = new lk.Room({
      adaptiveStream: false,
      dynacast: false,
      audioCaptureDefaults: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        ...(deviceId ? { deviceId } : {}),
      },
    });
    room.current = r;
    live.current = true;
    greeted.current = false;
    // Solo en construcciones de prueba: las E2E provocan reconexiones reales
    // del cliente (simulateScenario) sobre esta sala.
    if (process.env.NEXT_PUBLIC_FLUVIA_E2E_HOOKS === '1')
      (window as unknown as { __fluviaCallRoom?: Room }).__fluviaCallRoom = r;
    r.on(lk.RoomEvent.TrackSubscribed, (track, _pub, participant) => {
      if (participant.identity !== AGENT || track.kind !== lk.Track.Kind.Audio) return;
      const el = track.attach();
      el.setAttribute('data-fluvia-agent-audio', '');
      el.hidden = true;
      document.body.appendChild(el);
      audioEls.current.push(el);
      meterAgent(track);
    });
    r.on(lk.RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
      if (topic !== TOPIC || participant?.identity !== AGENT) return;
      try {
        onAgentMessage(JSON.parse(new TextDecoder().decode(payload)) as AgentMsg);
      } catch {
        /* mensaje ilegible: se ignora */
      }
    });
    r.on(lk.RoomEvent.AudioPlaybackStatusChanged, () => setNeedsAudioUnlock(!r.canPlaybackAudio));
    let reconnecting = false;
    const onReconnecting = () => {
      if (reconnecting) return;
      reconnecting = true;
      setState('reconnecting');
      say('sistema', 'Se perdió la conexión; reconectando…');
    };
    r.on(lk.RoomEvent.SignalReconnecting, onReconnecting);
    r.on(lk.RoomEvent.Reconnecting, onReconnecting);
    r.on(lk.RoomEvent.Reconnected, () => {
      reconnecting = false;
      setState('connected');
      say('sistema', 'Conexión recuperada.');
    });
    r.on(lk.RoomEvent.ParticipantDisconnected, (p) => {
      if (p.identity !== AGENT) return;
      // En una reconexión completa el cliente rehace la sala y «saca» antes a
      // los participantes: solo si tras un margen la sala está conectada y
      // Fluvia no ha vuelto, se da por terminada.
      setTimeout(() => {
        if (
          live.current &&
          r.state === lk.ConnectionState.Connected &&
          !r.getParticipantByIdentity(AGENT)
        )
          void hangUp('Fluvia salió de la llamada.');
      }, AGENT_LEFT_GRACE_MS);
    });
    r.on(lk.RoomEvent.Disconnected, () => {
      if (live.current) void hangUp('La llamada se desconectó.');
    });
    try {
      await r.connect(g.body.url, g.body.token, { autoSubscribe: true });
    } catch {
      await release();
      setState('error');
      setError('No se pudo conectar con el servidor de llamadas. Sigue por chat.');
      return;
    }
    try {
      await r.localParticipant.setMicrophoneEnabled(true);
    } catch {
      await release();
      setState('denied');
      return;
    }
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      setDevices(list.filter((d) => d.kind === 'audioinput'));
    } catch {
      /* sin lista de dispositivos: se usa el predeterminado */
    }
    setNeedsAudioUnlock(!r.canPlaybackAudio);
    setState('connected');
    setElapsed(0);
    tick.current = setInterval(() => setElapsed((s) => s + 1), 1000);
    agentTimer.current = setTimeout(() => {
      if (live.current && !greeted.current) {
        void hangUp('Fluvia no se unió a la llamada. Inténtalo más tarde o sigue por chat.');
      }
    }, AGENT_JOIN_MS);
  };

  const toggleMute = async () => {
    const m = !muted;
    await room.current?.localParticipant.setMicrophoneEnabled(!m).catch(() => undefined);
    setMuted(m);
  };

  const changeDevice = async (id: string) => {
    setDeviceId(id);
    if (room.current) {
      const ok = await room.current.switchActiveDevice('audioinput', id).catch(() => false);
      if (!ok) setError('No se pudo usar ese micrófono.');
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
    ask('', [String(up.body.id)]);
  };

  const mm = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  const LABEL: Record<State, string> = {
    consent: 'Sin conectar',
    connecting: 'Conectando…',
    connected: 'Conectada',
    reconnecting: 'Reconectando…',
    ended: 'Finalizada',
    denied: 'Micrófono denegado',
    error: 'Error',
  };
  const inCall = state === 'connected' || state === 'reconnecting';

  return (
    <section
      className="as-body as-call"
      aria-labelledby="as-call-title"
      data-call-transport="webrtc"
      data-call-state={state}
      data-agent-audio={heardAgent ? 'received' : 'none'}
    >
      <h3 id="as-call-title">
        Hablar con Fluvia{' '}
        {agent?.test ? <span className="as-sim-chip">Agente de prueba</span> : null}
      </h3>
      <p className="as-call-state" role="status" aria-live="polite">
        Estado: <strong>{LABEL[state]}</strong>
        {inCall ? ` · ${mm(elapsed)} de ${mm(maxSeconds)}` : ''}
      </p>

      {state === 'consent' ? (
        <div className="as-call-consent">
          <p>
            Usaremos tu micrófono solo durante la llamada. Tu voz viaja cifrada hasta el servidor de
            llamadas de Fluvia, se transcribe y queda en tu conversación. Fluvia solo puede
            consultar, nunca mover dinero. Puedes silenciarte o colgar en cualquier momento.
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

      {inCall ? (
        <>
          <div className="as-meter" aria-hidden="true">
            <span style={{ transform: `scaleX(${Math.min(1, agentLevel * 8)})` }} />
          </div>
          <p className="as-muted">
            {muted
              ? 'Micrófono silenciado.'
              : !agent
                ? 'Esperando a Fluvia…'
                : agentSpeaking
                  ? 'Fluvia está hablando: puedes interrumpir.'
                  : thinking
                    ? 'Fluvia está consultando…'
                    : 'Te escucho.'}
            {heardAgent ? ' · Audio de Fluvia recibido.' : ''}
          </p>
          {agent ? (
            <p className="as-muted">
              Voz: transcripción {agent.stt.simulated ? 'de prueba' : agent.stt.provider} · voz{' '}
              {agent.tts.simulated ? 'de prueba' : agent.tts.provider}.
            </p>
          ) : null}
          {needsAudioUnlock ? (
            <button
              type="button"
              className="as-btn"
              onClick={() => void room.current?.startAudio().then(() => setNeedsAudioUnlock(false))}
            >
              Activar el sonido de Fluvia
            </button>
          ) : null}
          <div className="as-call-actions">
            <button
              type="button"
              className="as-btn"
              onClick={() => void toggleMute()}
              aria-pressed={muted}
            >
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
            <button type="button" className="as-hangup" onClick={() => void hangUp()}>
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
