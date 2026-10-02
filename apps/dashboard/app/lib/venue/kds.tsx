'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { errorMessage } from '../client-call';
import { vcall, vpath, MODE_LABEL, type KitchenTicket } from './api';

/**
 * Pantalla de cocina (KDS) para tablet y monitor.
 *
 *  - La VERDAD es la instantánea del servidor: al abrir, al reconectar y ante
 *    cada aviso del stream se pide de nuevo. Así una caída no pierde comandas
 *    ni las duplica (los avisos pueden llegar desordenados).
 *  - Una acción nunca se marca hecha antes de que el servidor la confirme: el
 *    botón queda «enviando» y el estado cambia con la respuesta.
 *  - Estado siempre en texto (no solo color ni sonido); sonido opcional.
 *  - Teclado: flechas para moverse entre comandas, Enter para la acción.
 */

type Conn = 'connecting' | 'live' | 'reconnecting';

const NEXT: Record<KitchenTicket['status'], KitchenTicket['status'] | null> = {
  queued: 'accepted',
  accepted: 'preparing',
  preparing: 'ready',
  ready: 'delivered',
  delivered: null,
};
const ACTION_LABEL: Record<string, string> = {
  accepted: 'Aceptar',
  preparing: 'En preparación',
  ready: 'Listo',
  delivered: 'Entregado',
};
const STATUS_LABEL: Record<KitchenTicket['status'], string> = {
  queued: 'Nueva',
  accepted: 'Aceptada',
  preparing: 'En preparación',
  ready: 'Lista',
  delivered: 'Entregada',
};
const KIND_LABEL: Record<KitchenTicket['kind'], string> = {
  new: 'Comanda',
  addition: 'Agregado',
  void: 'Anulación',
};
const LATE_MS = 15 * 60_000;

function elapsed(fromIso: string, now: number): string {
  const s = Math.max(0, Math.floor((now - new Date(fromIso).getTime()) / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function beep() {
  try {
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = 880;
    g.gain.value = 0.15;
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.25);
  } catch {
    /* sin audio: el aviso visual y el anuncio de texto siguen */
  }
}

export function KitchenDisplay({
  orgId,
  branches,
  canRecall,
}: {
  orgId: string;
  branches: Array<{ id: string; name: string; stations: Array<{ code: string; name: string }> }>;
  canRecall: boolean;
}) {
  const [branchId, setBranchId] = useState(branches[0]?.id ?? '');
  const [station, setStation] = useState<string | null>(null);
  const [tickets, setTickets] = useState<KitchenTicket[]>([]);
  const [history, setHistory] = useState<KitchenTicket[] | null>(null);
  const [conn, setConn] = useState<Conn>('connecting');
  const [lastSync, setLastSync] = useState<number | null>(null);
  const [sound, setSound] = useState(false);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  // Error de lectura (se limpia con la siguiente instantánea correcta) y error
  // de una acción (queda visible hasta la próxima acción).
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const seen = useRef<Set<string> | null>(null);
  const announce = useRef<HTMLParagraphElement>(null);
  const cursor = useRef(0);
  const soundRef = useRef(sound);
  soundRef.current = sound;
  const branch = branches.find((b) => b.id === branchId);

  const load = useCallback(async () => {
    if (!branchId) return;
    const qs = new URLSearchParams({ branch_id: branchId });
    if (station) qs.set('station', station);
    const r = await vcall<{ cursor: number; tickets: KitchenTicket[] }>(
      orgId,
      `kitchen/snapshot?${qs.toString()}`
    );
    if (r.kind !== 'ok') {
      setLoadError(errorMessage(r));
      return;
    }
    setLoadError(null);
    cursor.current = Math.max(cursor.current, r.body.cursor);
    const ids = new Set(r.body.tickets.map((t) => t.id));
    if (seen.current) {
      const added = r.body.tickets.filter((t) => !seen.current!.has(t.id) && t.status === 'queued');
      if (added.length) {
        setFresh(new Set(added.map((t) => t.id)));
        if (soundRef.current) beep();
        if (announce.current) {
          announce.current.textContent = added
            .map(
              (t) =>
                `${KIND_LABEL[t.kind]} nueva: pedido ${t.order_number}${t.table_label ? `, mesa ${t.table_label}` : ''}`
            )
            .join('. ');
        }
      }
    }
    seen.current = ids;
    setTickets(r.body.tickets);
    setLastSync(Date.now());
  }, [orgId, branchId, station]);

  // Stream en vivo + instantánea. Al reconectar, EventSource vuelve a abrir y
  // el evento `ready` dispara otra instantánea (recupera lo perdido).
  useEffect(() => {
    if (!branchId) return;
    seen.current = null;
    void load();
    let es: EventSource | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => void load(), 150);
    };
    const open = () => {
      const qs = new URLSearchParams({ branch_id: branchId, since: String(cursor.current) });
      es = new EventSource(vpath(orgId, `dining/stream?${qs.toString()}`));
      es.addEventListener('ready', () => {
        setConn('live');
        refresh();
      });
      es.addEventListener('changed', (ev) => {
        try {
          const d = JSON.parse((ev as MessageEvent).data) as { cursor: number };
          cursor.current = Math.max(cursor.current, d.cursor);
        } catch {
          /* aviso ilegible: igual se pide la instantánea */
        }
        refresh();
      });
      es.addEventListener('ping', () => setConn('live'));
      es.onerror = () => setConn('reconnecting');
    };
    open();
    // Respaldo: aunque el stream caiga, la instantánea se renueva.
    poll = setInterval(() => void load(), 20_000);
    return () => {
      es?.close();
      if (poll) clearInterval(poll);
      if (debounce) clearTimeout(debounce);
    };
  }, [orgId, branchId, load]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  async function act(t: KitchenTicket, to: KitchenTicket['status'], reason?: string) {
    setError(null);
    setBusy((b) => ({ ...b, [t.id]: true }));
    const r = await vcall<KitchenTicket>(orgId, `kitchen/tickets/${t.id}/action`, {
      method: 'POST',
      body: { to, expected_version: t.version, ...(reason ? { reason } : {}) },
    });
    setBusy((b) => ({ ...b, [t.id]: false }));
    if (r.kind === 'ok') {
      setTickets((list) => list.map((x) => (x.id === t.id ? r.body : x)));
      setFresh((f) => {
        const n = new Set(f);
        n.delete(t.id);
        return n;
      });
      if (history) void loadHistory();
    } else {
      // Otro dispositivo se adelantó o se perdió la red: la instantánea manda.
      setError(
        r.kind === 'http' && r.code === 'version_conflict'
          ? 'Otra pantalla cambió esta comanda. Se actualizó con el estado real.'
          : errorMessage(r)
      );
      void load();
    }
  }

  async function loadHistory() {
    const r = await vcall<{ data: KitchenTicket[] }>(
      orgId,
      `kitchen/history?branch_id=${branchId}`
    );
    if (r.kind === 'ok') setHistory(r.body.data);
  }

  const visible = useMemo(
    () =>
      tickets
        .filter((t) => t.status !== 'delivered')
        .sort((a, b) => a.created_at.localeCompare(b.created_at)),
    [tickets]
  );

  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const cards = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[data-card]'));
    const i = cards.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    const step =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? -1
          : 0;
    if (step) {
      e.preventDefault();
      cards[(i + step + cards.length) % cards.length]?.focus();
    }
  };

  return (
    <div className="vn-kds">
      <p ref={announce} className="fx-sr" aria-live="assertive" />
      <div className="vn-kds-bar">
        <h1>Cocina{branch ? ` · ${branch.name}` : ''}</h1>
        <span className="vn-conn" data-s={conn} role="status">
          {conn === 'live' ? 'En vivo' : conn === 'connecting' ? 'Conectando…' : 'Reconectando…'}
          {lastSync ? ` · act. ${new Date(lastSync).toLocaleTimeString('es')}` : ''}
        </span>
        <button
          type="button"
          className="vn-chip"
          aria-pressed={sound}
          onClick={() => {
            setSound(!sound);
            if (!sound) beep();
          }}
        >
          Sonido
        </button>
        <button
          type="button"
          className="vn-chip"
          aria-pressed={history !== null}
          onClick={() => (history ? setHistory(null) : void loadHistory())}
        >
          Historial
        </button>
        <button
          type="button"
          className="vn-chip"
          onClick={() => void document.documentElement.requestFullscreen?.().catch(() => undefined)}
        >
          Pantalla completa
        </button>
      </div>
      {branches.length > 1 ? (
        <div className="vn-chips" role="group" aria-label="Sucursal">
          {branches.map((b) => (
            <button
              key={b.id}
              type="button"
              className="vn-chip"
              aria-pressed={b.id === branchId}
              onClick={() => setBranchId(b.id)}
            >
              {b.name}
            </button>
          ))}
        </div>
      ) : null}
      <div className="vn-chips" role="group" aria-label="Estación">
        <button
          type="button"
          className="vn-chip"
          aria-pressed={station === null}
          onClick={() => setStation(null)}
        >
          Todas
        </button>
        {(branch?.stations ?? []).map((s) => (
          <button
            key={s.code}
            type="button"
            className="vn-chip"
            aria-pressed={station === s.code}
            onClick={() => setStation(s.code)}
          >
            {s.name}
          </button>
        ))}
      </div>
      {error || loadError ? (
        <div className="fx-callout" data-tone="warn" role="alert">
          <div>
            {error ? <p>{error}</p> : null}
            {loadError ? <p>No se pudo actualizar: {loadError}</p> : null}
          </div>
        </div>
      ) : null}

      {history ? (
        <section aria-labelledby="hist-title">
          <h2 id="hist-title" style={{ color: 'var(--fl-white)' }}>
            Entregadas (últimas)
          </h2>
          <div className="vn-kds-grid">
            {history.map((t) => (
              <TicketCard
                key={t.id}
                t={t}
                now={now}
                busy={!!busy[t.id]}
                fresh={false}
                canRecall={canRecall}
                onAct={act}
              />
            ))}
          </div>
        </section>
      ) : (
        <div
          className="vn-kds-grid"
          onKeyDown={onGridKey}
          aria-label="Comandas activas"
          role="list"
        >
          {visible.length === 0 ? (
            <p style={{ color: 'var(--fl-white)', fontSize: '1.25rem' }}>
              Sin comandas pendientes.
            </p>
          ) : null}
          {visible.map((t) => (
            <TicketCard
              key={t.id}
              t={t}
              now={now}
              busy={!!busy[t.id]}
              fresh={fresh.has(t.id)}
              canRecall={canRecall}
              onAct={act}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TicketCard({
  t,
  now,
  busy,
  fresh,
  canRecall,
  onAct,
}: {
  t: KitchenTicket;
  now: number;
  busy: boolean;
  fresh: boolean;
  canRecall: boolean;
  onAct: (t: KitchenTicket, to: KitchenTicket['status'], reason?: string) => Promise<void>;
}) {
  const next = NEXT[t.status];
  const [recalling, setRecalling] = useState(false);
  const [reason, setReason] = useState('');
  const late = t.status !== 'delivered' && now - new Date(t.created_at).getTime() > LATE_MS;
  const where = t.table_label ? `Mesa ${t.table_label}` : MODE_LABEL[t.mode];
  return (
    <article
      className="vn-kds-card"
      data-card
      data-new={fresh}
      data-kind={t.kind}
      data-late={late}
      tabIndex={0}
      role="listitem"
      aria-label={`${KIND_LABEL[t.kind]} ${t.number}, ${where}, ${STATUS_LABEL[t.status]}`}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.target === e.currentTarget && next && !busy) void onAct(t, next);
      }}
    >
      <div className="vn-kds-head">
        <strong>#{t.order_number}</strong>
        <span className="vn-kds-time" title="Tiempo desde que llegó">
          {elapsed(t.created_at, now)}
          {late ? ' · demora' : ''}
        </span>
      </div>
      <div className="vn-kds-head">
        <span>
          {where}
          {t.customer_name ? ` · ${t.customer_name}` : ''}
        </span>
        <span className="vn-kds-kind">
          {KIND_LABEL[t.kind]}
          {t.revision > 1 ? ` (rev. ${t.revision})` : ''} · {t.station_code}
        </span>
      </div>
      <p className="vn-status" data-s={t.status === 'ready' ? 'ready' : 'x'}>
        {STATUS_LABEL[t.status]}
      </p>
      <ul className="vn-kds-items">
        {t.items.map((i) => (
          <li key={i.line_id} data-voided={i.voided}>
            <strong>{i.quantity}×</strong> {i.name}
            {i.voided ? ` — ANULADO${i.void_reason ? `: ${i.void_reason}` : ''}` : ''}
            {i.modifiers.length ? <small>{i.modifiers.join(' · ')}</small> : null}
            {i.note ? <small>Nota: {i.note}</small> : null}
          </li>
        ))}
      </ul>
      {t.order_note ? <p className="vn-kds-note">Pedido: {t.order_note}</p> : null}
      {next ? (
        <button
          type="button"
          className="vn-kds-action"
          aria-busy={busy}
          disabled={busy}
          onClick={() => void onAct(t, next)}
        >
          {busy
            ? 'Enviando…'
            : t.kind === 'void' && next === 'accepted'
              ? 'Enterado'
              : ACTION_LABEL[next]}
        </button>
      ) : null}
      {canRecall && (t.status === 'ready' || t.status === 'delivered') ? (
        recalling ? (
          <form
            className="vn-row"
            onSubmit={(e) => {
              e.preventDefault();
              if (reason.trim().length >= 3)
                void onAct(t, 'preparing', reason.trim()).then(() => setRecalling(false));
            }}
          >
            <label className="fx-field vn-grow">
              <span>Motivo</span>
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                minLength={3}
                maxLength={200}
                autoFocus
              />
            </label>
            <button
              type="submit"
              className="vn-kds-action vn-secondary"
              disabled={reason.trim().length < 3 || busy}
            >
              Volver a preparación
            </button>
          </form>
        ) : (
          <button
            type="button"
            className="vn-kds-action vn-secondary"
            onClick={() => setRecalling(true)}
          >
            Marcada por error…
          </button>
        )
      ) : null}
    </article>
  );
}
