'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from './csrf-header';
import { Icon } from './icons';
import { CallPanel } from './call';
import { assistantError, call, readSse, upload } from './sse';
import { VoiceNote } from './voice-note';
import './assistant.css';

/**
 * Asistente «Fluvia» (Personal y Comercio). Un panel por superficie:
 *  - panel lateral en escritorio, pantalla completa en móvil; diálogo modal
 *    con foco atrapado, Escape para cerrar y foco devuelto al botón que lo
 *    abrió;
 *  - historial de conversaciones, respuesta en streaming, detener, reintentar
 *    y recuperación de errores;
 *  - indicador claro de IA (y de proveedor simulado cuando lo es);
 *  - acciones sugeridas = enlaces a pantallas reales;
 *  - contexto mínimo: ruta actual y tarea. Nunca el contenido de la página.
 */

interface Action {
  id: string;
  label: string;
  href: string;
}
interface Msg {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  input_mode: 'text' | 'voice' | 'call';
  attachment_ids: string[];
  actions: Action[];
  simulated: boolean;
  status: 'complete' | 'cancelled' | 'error' | 'streaming';
  error?: string;
  retryText?: string;
  /** Clave del turno: el reintento reutiliza la misma (sin duplicar el mensaje). */
  clientId?: string;
  retryIds?: string[];
}
interface Conv {
  id: string;
  title: string;
  updated_at: string;
}
interface Status {
  conversation: { simulated: boolean };
  speech_to_text: { simulated: boolean };
  text_to_speech: { simulated: boolean };
  call: { simulated: boolean };
  limits: { max_input_chars: number; max_images_per_message: number; max_audio_seconds: number };
}
interface Pending {
  key: string;
  file: File;
  preview: string;
  progress: number;
  id: string | null;
  error: string | null;
}

interface Ctx {
  open: (opener: HTMLElement | null) => void;
  isOpen: boolean;
}
const AssistantContext = createContext<Ctx | null>(null);

/** Comprador: solo su checkout o su pedido (lo impone el servidor). */
export type Surface = 'personal' | 'commerce' | 'buyer';

const COPY: Record<Surface, { title: string; intro: string; suggest: string[] }> = {
  personal: {
    title: 'Fluvia · Personal',
    intro: 'tu saldo, tu crédito, tus cuotas o tu tarjeta',
    suggest: ['¿Cuál es mi saldo?', '¿Cuándo vence mi próxima cuota?', '¿Cómo bloqueo mi tarjeta?'],
  },
  commerce: {
    title: 'Fluvia · Comercio',
    intro: 'tus ventas, cobros por confirmar o tu perfil en el directorio',
    suggest: [
      '¿Cuánto vendí esta semana?',
      '¿Hay cobros por confirmar?',
      '¿Estoy en el directorio?',
    ],
  },
  buyer: {
    title: 'Fluvia · Tu pedido',
    intro: 'el estado de tu pedido o de tu pago, o qué lleva un plato según el menú del local',
    suggest: [
      '¿Cómo va mi pedido?',
      '¿Ya está pagada mi cuenta?',
      '¿Qué alérgenos tiene mi plato?',
    ],
  },
};

export function AssistantRoot({
  base,
  surface,
  task,
  children,
}: {
  /**
   * BFF: `/api/assistant/personal`, `/api/assistant/o/<org>` (panel) o
   * `/api/asistente/<clave>` (comprador en el checkout).
   */
  base: string;
  surface: Surface;
  task?: string;
  children: ReactNode;
}) {
  const [isOpen, setOpen] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const open = useCallback((el: HTMLElement | null) => {
    opener.current = el;
    setOpen(true);
  }, []);
  const close = useCallback(() => {
    setOpen(false);
    requestAnimationFrame(() => opener.current?.focus());
  }, []);
  return (
    <AssistantContext.Provider value={{ open, isOpen }}>
      {children}
      {isOpen ? <AssistantPanel base={base} surface={surface} task={task} onClose={close} /> : null}
    </AssistantContext.Provider>
  );
}

export function AssistantTrigger({
  className,
  compact,
}: {
  className?: string;
  compact?: boolean;
}) {
  const ctx = useContext(AssistantContext);
  if (!ctx) return null;
  return (
    <button
      type="button"
      className={className ?? 'as-trigger'}
      aria-haspopup="dialog"
      aria-expanded={ctx.isOpen}
      onClick={(e) => ctx.open(e.currentTarget)}
    >
      <Icon name="ai" />
      <span className={compact ? 'sr-only' : undefined}>Pregunta a Fluvia</span>
    </button>
  );
}

/** Lleva la vista y el foco a un elemento de la página por su id. */
function focusAnchor(id: string) {
  // Dos fotogramas: después de que el cierre devuelva el foco al disparador.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const el = document.getElementById(id);
      if (!el) return;
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
      el.scrollIntoView({ block: 'start' });
      el.focus({ preventScroll: true });
    })
  );
}

const SAFETY =
  'Fluvia es una IA y puede equivocarse. No compartas números de tarjeta completos, CVV, contraseñas ni códigos.';

function AssistantPanel({
  base,
  surface,
  task,
  onClose,
}: {
  base: string;
  surface: Surface;
  task?: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const listEnd = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [view, setView] = useState<'chat' | 'history' | 'call'>('chat');
  const [convs, setConvs] = useState<Conv[] | null>(null);
  const [convId, setConvId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [text, setText] = useState('');
  const [inputMode, setInputMode] = useState<'text' | 'voice'>('text');
  const [pending, setPending] = useState<Pending[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [composerError, setComposerError] = useState<string | null>(null);
  const stream = useRef<AbortController | null>(null);

  // Estado y proveedores (para el indicador «simulado»).
  useEffect(() => {
    void call<Status>(`${base}/status`).then((r) => {
      if (r.ok) setStatus(r.body);
      else setStatusError(assistantError(r.status, r.code));
    });
  }, [base]);

  // Foco inicial, Escape y foco atrapado dentro del diálogo.
  useEffect(() => {
    input.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
      if (e.key !== 'Tab' || !dialog.current) return;
      const f = Array.from(
        dialog.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select, audio[controls], [tabindex="0"]'
        )
      ).filter((el) => el.offsetParent !== null);
      if (!f.length) return;
      const first = f[0]!;
      const last = f[f.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
      stream.current?.abort();
    };
  }, [onClose]);

  useEffect(() => {
    listEnd.current?.scrollIntoView({ block: 'end' });
  }, [msgs]);

  const loadHistory = async () => {
    setView('history');
    setConvs(null);
    const r = await call<{ data: Conv[] }>(`${base}/conversations`);
    setConvs(r.ok ? r.body.data : []);
    if (!r.ok) setNotice(assistantError(r.status, r.code));
  };

  const openConversation = async (id: string) => {
    setView('chat');
    setConvId(id);
    setLoadingMsgs(true);
    const r = await call<{ data: Msg[] }>(`${base}/conversations/${id}/messages`);
    setLoadingMsgs(false);
    if (r.ok) setMsgs(r.body.data);
    else setNotice(assistantError(r.status, r.code));
    requestAnimationFrame(() => input.current?.focus());
  };

  const newConversation = () => {
    stream.current?.abort();
    setConvId(null);
    setMsgs([]);
    setView('chat');
    requestAnimationFrame(() => input.current?.focus());
  };

  // ── Fotos ──────────────────────────────────────────────────────────────────
  const addFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setComposerError(null);
    const max = status?.limits.max_images_per_message ?? 3;
    const room = Math.max(0, max - pending.length);
    for (const file of Array.from(files).slice(0, room)) {
      const key = `${Date.now()}-${Math.random()}`;
      const item: Pending = {
        key,
        file,
        preview: URL.createObjectURL(file),
        progress: 0,
        id: null,
        error: null,
      };
      setPending((p) => [...p, item]);
      const r = await upload(`${base}/attachments`, 'image', file, (f) =>
        setPending((p) => p.map((x) => (x.key === key ? { ...x, progress: f } : x)))
      );
      setPending((p) =>
        p.map((x) =>
          x.key === key
            ? r.ok
              ? { ...x, id: String(r.body.id), progress: 1 }
              : { ...x, error: assistantError(r.status, r.code) }
            : x
        )
      );
    }
    if (files.length > room) setComposerError(`Máximo ${max} fotos por mensaje.`);
  };

  const removePending = async (key: string) => {
    const item = pending.find((p) => p.key === key);
    setPending((p) => p.filter((x) => x.key !== key));
    if (item) URL.revokeObjectURL(item.preview);
    if (item?.id) await call(`${base}/attachments/${item.id}/delete`, { method: 'POST' });
  };

  // ── Enviar con streaming ───────────────────────────────────────────────────
  const send = async (
    override?: string,
    opts: { ids?: string[]; mode?: 'call'; clientId?: string } = {}
  ): Promise<string | null> => {
    const body = (override ?? text).trim();
    const ids =
      opts.ids ?? (override !== undefined ? [] : pending.filter((p) => p.id).map((p) => p.id!));
    if (busy || (!body && ids.length === 0)) return null;
    if (override === undefined && pending.some((p) => !p.id && !p.error)) {
      setComposerError('Espera a que terminen de subir las fotos.');
      return null;
    }
    setComposerError(null);
    setBusy(true);
    let id = convId;
    if (!id) {
      const c = await call<Conv>(`${base}/conversations`, {
        method: 'POST',
        json: { title: body.slice(0, 60) || 'Foto' },
      });
      if (!c.ok) {
        setBusy(false);
        setComposerError(assistantError(c.status, c.code));
        return null;
      }
      id = c.body.id;
      setConvId(id);
    }
    const clientId = opts.clientId ?? crypto.randomUUID();
    const tempUser: Msg = {
      clientId,
      id: `tmp-u-${Date.now()}`,
      role: 'user',
      content: body,
      input_mode: opts.mode ?? inputMode,
      attachment_ids: ids,
      actions: [],
      simulated: false,
      status: 'complete',
    };
    const tempAsst: Msg = {
      clientId,
      id: `tmp-a-${Date.now()}`,
      role: 'assistant',
      content: '',
      input_mode: 'text',
      attachment_ids: [],
      actions: [],
      simulated: status?.conversation.simulated ?? false,
      status: 'streaming',
    };
    setMsgs((m) => [...m, tempUser, tempAsst]);
    if (override === undefined) {
      setText('');
      setPending([]);
    }
    const mode = opts.mode ?? inputMode;
    let finalText: string | null = null;
    setInputMode('text');
    setNotice('Fluvia está respondiendo…');

    const ac = new AbortController();
    stream.current = ac;
    const patch = (fn: (m: Msg) => Msg) =>
      setMsgs((all) => all.map((m) => (m.id === tempAsst.id ? fn(m) : m)));
    try {
      const res = await fetch(`${base}/conversations/${id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [CSRF_HEADER]: CSRF_HEADER_VALUE },
        body: JSON.stringify({
          text: body,
          attachment_ids: ids,
          client_message_id: clientId,
          input_mode: mode,
          context: { route: window.location.pathname, ...(task ? { task } : {}) },
        }),
        signal: ac.signal,
      });
      if (!res.ok) {
        let code: string | undefined;
        try {
          code = ((await res.json()) as { error?: { code?: string } }).error?.code;
        } catch {
          /* */
        }
        setMsgs((all) => all.filter((m) => m.id !== tempUser.id));
        patch((m) => ({
          ...m,
          status: 'error',
          error: assistantError(res.status, code),
          retryText: body,
          retryIds: ids,
        }));
        setNotice('No se pudo enviar.');
        return null;
      }
      for await (const ev of readSse(res)) {
        if (ev.event === 'start') {
          const u = { ...(ev.data.user_message as Msg), clientId };
          setMsgs((all) =>
            all.filter((m) => m.id !== u.id).map((m) => (m.id === tempUser.id ? u : m))
          );
        } else if (ev.event === 'delta') {
          patch((m) => ({ ...m, content: m.content + String(ev.data.text ?? '') }));
        } else if (ev.event === 'tool') {
          setNotice('Fluvia está consultando tus datos…');
        } else if (ev.event === 'done') {
          const final = ev.data.message as Msg;
          patch(() => final);
          finalText = final.content;
          setNotice('Respuesta lista.');
        } else if (ev.event === 'error') {
          const saved = ev.data.message as Msg | null;
          patch((m) => ({
            ...(saved ?? m),
            status: 'error',
            error: assistantError(500, String(ev.data.code ?? '')),
            retryText: body,
            retryIds: ids,
          }));
          setNotice('La respuesta no se completó.');
        }
      }
    } catch {
      if (ac.signal.aborted) {
        patch((m) => ({ ...m, status: 'cancelled' }));
        setNotice('Respuesta detenida.');
      } else {
        patch((m) => ({
          ...m,
          status: 'error',
          error: assistantError(0),
          retryText: body,
          retryIds: ids,
        }));
        setNotice('Se perdió la conexión.');
      }
    } finally {
      stream.current = null;
      setBusy(false);
      if (!opts.mode) requestAnimationFrame(() => input.current?.focus());
    }
    return finalText;
  };

  // La llamada guarda su `onAsk` al conectar; con esta referencia cada turno
  // usa el `send` del último render (conversación y estado actuales), así la
  // llamada continúa la MISMA conversación del chat.
  const sendRef = useRef(send);
  sendRef.current = send;

  const stop = () => stream.current?.abort();

  const speak = async (m: Msg) => {
    const res = await fetch(`${base}/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [CSRF_HEADER]: CSRF_HEADER_VALUE },
      body: JSON.stringify({ text: m.content.slice(0, 1000) }),
    }).catch(() => null);
    if (!res?.ok) {
      setNotice('No se pudo generar el audio. El texto sigue disponible.');
      return;
    }
    const url = URL.createObjectURL(await res.blob());
    const a = new Audio(url);
    a.onended = () => URL.revokeObjectURL(url);
    void a.play().catch(() => setNotice('El navegador bloqueó la reproducción.'));
  };

  const simulated = status?.conversation.simulated;
  const title = COPY[surface].title;

  return (
    <div className="as-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={dialog}
        className="as-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="as-title"
        aria-describedby="as-safety"
      >
        <header className="as-head">
          <div className="as-title">
            <h2 id="as-title">{title}</h2>
            <span className="as-ai-chip">
              <Icon name="ai" size={14} /> IA
            </span>
            {simulated ? <span className="as-sim-chip">Proveedor simulado</span> : null}
          </div>
          <div className="as-head-actions">
            <button type="button" className="as-icon-btn" onClick={newConversation}>
              <Icon name="plus" />
              <span className="sr-only">Nueva conversación</span>
            </button>
            <button
              type="button"
              className="as-icon-btn"
              onClick={() => (view === 'history' ? setView('chat') : void loadHistory())}
              aria-pressed={view === 'history'}
            >
              <Icon name="list" />
              <span className="sr-only">Historial</span>
            </button>
            <button
              type="button"
              className="as-icon-btn"
              onClick={() => setView(view === 'call' ? 'chat' : 'call')}
              aria-pressed={view === 'call'}
            >
              <Icon name="phone" />
              <span className="sr-only">Hablar con Fluvia</span>
            </button>
            <button type="button" className="as-icon-btn" onClick={onClose}>
              <Icon name="close" />
              <span className="sr-only">Cerrar asistente</span>
            </button>
          </div>
        </header>
        <p id="as-safety" className="as-safety">
          {SAFETY}
        </p>
        {statusError ? (
          <p className="as-error" role="alert">
            {statusError}
          </p>
        ) : null}

        <p className="sr-only" role="status" aria-live="polite">
          {notice}
        </p>

        {view === 'history' ? (
          <section className="as-body" aria-label="Historial de conversaciones">
            {convs === null ? (
              <p className="as-muted">Cargando…</p>
            ) : convs.length === 0 ? (
              <p className="as-muted">Aún no tienes conversaciones.</p>
            ) : (
              <ul className="as-history">
                {convs.map((c) => (
                  <li key={c.id}>
                    <button type="button" onClick={() => void openConversation(c.id)}>
                      <strong>{c.title}</strong>
                      <span>{new Date(c.updated_at).toLocaleString('es-VE')}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : view === 'call' ? (
          <CallPanel
            base={base}
            simulated={status?.call.simulated ?? true}
            onAsk={(t, ids) => sendRef.current(t, { ids, mode: 'call' })}
            onClose={() => setView('chat')}
          />
        ) : (
          <>
            <section className="as-body" aria-label="Conversación">
              {loadingMsgs ? <p className="as-muted">Cargando conversación…</p> : null}
              {msgs.length === 0 && !loadingMsgs ? (
                <div className="as-empty">
                  <p>
                    Pregúntame por {COPY[surface].intro}.{' '}
                    {surface === 'buyer'
                      ? 'Te llevo al control correcto de esta página.'
                      : 'Te llevo a la pantalla correcta.'}
                  </p>
                  <ul className="as-suggest">
                    {COPY[surface].suggest.map((s) => (
                      <li key={s}>
                        <button type="button" onClick={() => void send(s)} disabled={busy}>
                          {s}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <ol className="as-msgs">
                {msgs.map((m) => (
                  <li key={m.id} className="as-msg" data-role={m.role} data-status={m.status}>
                    {m.role === 'user' ? (
                      <>
                        {m.attachment_ids.length ? (
                          <div className="as-thumbs">
                            {m.attachment_ids.map((a) => (
                              <img
                                key={a}
                                src={`${base}/attachments/${a}/content`}
                                alt="Foto enviada"
                              />
                            ))}
                          </div>
                        ) : null}
                        {m.input_mode === 'voice' ? (
                          <span className="as-tag">Transcripción de voz</span>
                        ) : null}
                        {m.input_mode === 'call' ? (
                          <span className="as-tag">Desde la llamada</span>
                        ) : null}
                        {m.content ? <p>{m.content}</p> : null}
                      </>
                    ) : (
                      <>
                        <span className="as-who">
                          <Icon name="ai" size={14} /> Fluvia
                          {m.simulated ? <span className="as-sim-chip">Simulado</span> : null}
                        </span>
                        {m.content ? (
                          <p>{m.content}</p>
                        ) : m.status === 'streaming' ? (
                          <p className="as-muted">Pensando…</p>
                        ) : null}
                        {m.status === 'cancelled' ? (
                          <p className="as-muted">Respuesta detenida.</p>
                        ) : null}
                        {m.status === 'error' ? (
                          <div className="as-error" role="alert">
                            <p>{m.error ?? 'No se pudo completar.'}</p>
                            {m.retryText ? (
                              <button
                                type="button"
                                className="as-btn"
                                onClick={() => {
                                  // Mismo turno: se quitan sus burbujas y se reenvía con
                                  // la MISMA clave (el servidor no lo duplica).
                                  setMsgs((all) =>
                                    all.filter((x) =>
                                      m.clientId ? x.clientId !== m.clientId : x.id !== m.id
                                    )
                                  );
                                  void send(m.retryText, {
                                    ids: m.retryIds ?? [],
                                    clientId: m.clientId,
                                  });
                                }}
                                disabled={busy}
                              >
                                <Icon name="retry" /> Reintentar
                              </button>
                            ) : null}
                          </div>
                        ) : null}
                        {m.actions.length ? (
                          <ul className="as-actions" aria-label="Ir a">
                            {m.actions.map((a) => (
                              <li key={a.id}>
                                <a
                                  href={a.href}
                                  // Ancla de la misma página (comprador): se
                                  // cierra el panel y se lleva el foco al
                                  // control real SIN tocar el hash, que en el
                                  // checkout y el seguimiento guarda la
                                  // credencial de la página.
                                  onClick={(e) => {
                                    if (!a.href.startsWith('#')) return;
                                    e.preventDefault();
                                    onClose();
                                    focusAnchor(a.href.slice(1));
                                  }}
                                >
                                  {a.label} <Icon name="arrow-right" size={14} />
                                </a>
                              </li>
                            ))}
                          </ul>
                        ) : null}
                        {m.status === 'complete' && m.content ? (
                          <button type="button" className="as-link" onClick={() => void speak(m)}>
                            <Icon name="volume" size={14} /> Escuchar
                            {status?.text_to_speech.simulated ? ' (tono simulado)' : ''}
                          </button>
                        ) : null}
                      </>
                    )}
                  </li>
                ))}
              </ol>
              <div ref={listEnd} />
            </section>

            <form
              className="as-composer"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              {pending.length ? (
                <ul className="as-pending" aria-label="Fotos por enviar">
                  {pending.map((p) => (
                    <li key={p.key}>
                      <img src={p.preview} alt={`Vista previa de ${p.file.name}`} />
                      {p.error ? (
                        <span className="as-pending-err">{p.error}</span>
                      ) : p.id ? (
                        <span className="sr-only">Lista para enviar</span>
                      ) : (
                        <progress
                          max={1}
                          value={p.progress}
                          aria-label={`Subiendo ${p.file.name}`}
                        />
                      )}
                      <button
                        type="button"
                        className="as-icon-btn"
                        onClick={() => void removePending(p.key)}
                      >
                        <Icon name="trash" />
                        <span className="sr-only">Quitar {p.file.name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              {inputMode === 'voice' ? (
                <p className="as-tag" id="as-voice-hint">
                  Transcripción de tu nota de voz: revísala y corrígela antes de enviar.
                </p>
              ) : null}
              <label htmlFor="as-input" className="sr-only">
                Mensaje para Fluvia
              </label>
              <textarea
                id="as-input"
                ref={input}
                rows={2}
                value={text}
                maxLength={status?.limits.max_input_chars ?? 2000}
                placeholder="Escribe tu pregunta"
                aria-describedby={inputMode === 'voice' ? 'as-voice-hint' : undefined}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
              {composerError ? (
                <p className="as-error" role="alert">
                  {composerError}
                </p>
              ) : null}
              <div className="as-tools">
                <label className="as-icon-btn as-file">
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    multiple
                    onChange={(e) => {
                      void addFiles(e.target.files);
                      e.target.value = '';
                    }}
                  />
                  <Icon name="image" />
                  <span className="sr-only">Adjuntar foto</span>
                </label>
                <label className="as-icon-btn as-file">
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    capture="environment"
                    onChange={(e) => {
                      void addFiles(e.target.files);
                      e.target.value = '';
                    }}
                  />
                  <Icon name="camera" />
                  <span className="sr-only">Tomar foto con la cámara</span>
                </label>
                <VoiceNote
                  base={base}
                  maxSeconds={status?.limits.max_audio_seconds ?? 120}
                  simulated={status?.speech_to_text.simulated ?? true}
                  onTranscript={(t) => {
                    setText(t);
                    setInputMode('voice');
                    requestAnimationFrame(() => input.current?.focus());
                  }}
                />
                <span className="as-spacer" />
                {busy ? (
                  <button type="button" className="as-send" onClick={stop}>
                    <Icon name="stop" /> Detener
                  </button>
                ) : (
                  <button
                    type="submit"
                    className="as-send"
                    disabled={!text.trim() && !pending.some((p) => p.id)}
                  >
                    <Icon name="send" /> Enviar
                  </button>
                )}
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
