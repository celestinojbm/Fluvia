'use client';

import { useEffect, useRef, useState } from 'react';
import { Icon } from '../../lib/icons';
import { QrCode } from '../../lib/venue/qr';
import { newKey, personalCall, personalError, toMinor } from './client';
import { money } from './format';

interface PayCard {
  id: string;
  last4: string | null;
  currency: string;
}

/** Enlaces de pago que la app sabe abrir: checkout alojado, enlace de venta o menú QR. */
const PAY_PATH = /^\/(l|c)\/[0-9a-f-]{36}$|^\/m\/[A-Za-z0-9_-]{16,64}$/;

/**
 * Pagar (cliente). Tres caminos que existen hoy:
 *  - Mostrar código: código de un solo uso de tu tarjeta Fluvia, con importe
 *    máximo; el comercio lo escanea o lo escribe en su checkout.
 *  - Escanear: lee el QR de un cobro o de un menú y, tras confirmar el
 *    destino, lo abre (no se paga sin tu confirmación en la siguiente página).
 *  - Enviar a una persona: transferencia de saldo (pantalla existente).
 * Cobrar como comercio o independiente es OTRA app (panel del comercio).
 */
export function PayScreen({
  cards,
  installments,
}: {
  cards: PayCard[];
  installments: number | null;
}) {
  const [tab, setTab] = useState<'code' | 'scan'>('code');
  return (
    <div>
      <div className="pm-chips" role="tablist" aria-label="Cómo pagar" style={{ marginBottom: 8 }}>
        <button
          type="button"
          role="tab"
          className="pm-chip"
          aria-selected={tab === 'code'}
          aria-pressed={tab === 'code'}
          onClick={() => setTab('code')}
        >
          <Icon name="qr" size={16} /> Mostrar código
        </button>
        <button
          type="button"
          role="tab"
          className="pm-chip"
          aria-selected={tab === 'scan'}
          aria-pressed={tab === 'scan'}
          onClick={() => setTab('scan')}
        >
          <Icon name="scan" size={16} /> Escanear
        </button>
        <a className="pm-chip" href="/personal/movimientos?accion=enviar">
          <Icon name="send" size={16} /> Enviar a una persona
        </a>
      </div>
      {tab === 'code' ? <ShowCode cards={cards} installments={installments} /> : <Scan />}
    </div>
  );
}

function ShowCode({ cards, installments }: { cards: PayCard[]; installments: number | null }) {
  const [cardId, setCardId] = useState(cards[0]?.id ?? '');
  const card = cards.find((c) => c.id === cardId) ?? cards[0];
  const [digits, setDigits] = useState('');
  const [mode, setMode] = useState<'wallet' | 'installments'>('wallet');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [code, setCode] = useState<{ code: string; expires_at: string; max: string } | null>(null);
  const [left, setLeft] = useState(0);

  useEffect(() => {
    if (!code) return;
    const t = window.setInterval(() => {
      const s = Math.max(0, Math.round((Date.parse(code.expires_at) - Date.now()) / 1000));
      setLeft(s);
      if (s === 0) window.clearInterval(t);
    }, 1000);
    return () => window.clearInterval(t);
  }, [code]);

  if (!card) {
    return (
      <div className="pm-card">
        <p style={{ margin: '0 0 12px' }}>
          Para pagar en comercios necesitas una tarjeta Fluvia activa.
        </p>
        <a className="pm-cta" href="/personal/tarjetas">
          Pedir tarjeta
        </a>
      </div>
    );
  }
  const text = digits
    ? `${digits.slice(0, -2) || '0'},${digits.slice(-2).padStart(2, '0')}`
    : '0,00';
  const minor = toMinor(text);
  const press = (k: string) => {
    setErr(null);
    if (k === 'del') return setDigits((d) => d.slice(0, -1));
    if (digits.length >= 11) return;
    setDigits((d) => (d + k).replace(/^0+/, ''));
  };

  const generate = async () => {
    if (!minor) return setErr('Escribe el importe máximo que vas a pagar.');
    setBusy(true);
    setErr(null);
    const r = await personalCall<{ code: string; expires_at: string }>('payment-codes', {
      method: 'POST',
      idempotencyKey: newKey(),
      body: {
        card_id: card.id,
        mode,
        max_amount: minor,
        ...(mode === 'installments' && installments ? { installments_count: installments } : {}),
      },
    });
    setBusy(false);
    if (r.kind !== 'ok') return setErr(personalError(r));
    setCode({ ...r.body, max: minor });
  };

  if (code) {
    const mm = String(Math.floor(left / 60)).padStart(2, '0');
    const ss = String(left % 60).padStart(2, '0');
    return (
      <div className="pm-qr" aria-live="polite">
        <p className="pm-hero-label" style={{ margin: 0 }}>
          Muéstralo al comercio
        </p>
        <QrCode value={code.code} label="Código de pago de un solo uso" size={240} />
        <p style={{ margin: 0, fontWeight: 800 }}>
          Hasta <span className="pm-money">{money(code.max, card.currency)}</span> ·{' '}
          {mode === 'wallet'
            ? 'saldo propio'
            : `en ${installments} ${installments === 1 ? 'cuota' : 'cuotas'}`}
        </p>
        <p className="pm-muted" style={{ margin: 0 }}>
          {left > 0 ? `Caduca en ${mm}:${ss}. Válido una sola vez.` : 'Caducó. Genera otro.'}
        </p>
        <details style={{ width: '100%' }}>
          <summary className="pm-muted">El comercio no puede escanear: ver el código</summary>
          <p className="pm-code">{code.code}</p>
        </details>
        <button type="button" className="pm-cta is-ghost is-block" onClick={() => setCode(null)}>
          Listo
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="pm-amount-entry">
        <p className="pm-muted" style={{ margin: 0 }}>
          Importe máximo · {card.currency}
        </p>
        <output aria-live="polite" aria-label="Importe">
          {money(minor ?? '0', card.currency)}
        </output>
      </div>
      <div className="pm-keypad" aria-label="Teclado">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0'].map((k) => (
          <button key={k} type="button" onClick={() => press(k)}>
            {k}
          </button>
        ))}
        <button type="button" onClick={() => press('del')} aria-label="Borrar">
          ⌫
        </button>
      </div>
      <div className="pm-pay-actions">
        {cards.length > 1 ? (
          <label style={{ gridColumn: '1 / -1' }}>
            <span className="sr-only">Tarjeta</span>
            <select
              className="pm-field"
              value={card.id}
              onChange={(e) => setCardId(e.target.value)}
            >
              {cards.map((c) => (
                <option key={c.id} value={c.id}>
                  Tarjeta •••• {c.last4 ?? '····'} · {c.currency}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <button
          type="button"
          className="pm-chip"
          aria-pressed={mode === 'wallet'}
          onClick={() => setMode('wallet')}
          style={{ justifyContent: 'center', minHeight: 44 }}
        >
          Saldo propio
        </button>
        {installments ? (
          <button
            type="button"
            className="pm-chip"
            aria-pressed={mode === 'installments'}
            onClick={() => setMode('installments')}
            style={{ justifyContent: 'center', minHeight: 44 }}
          >
            En {installments} {installments === 1 ? 'cuota' : 'cuotas'}
          </button>
        ) : null}
      </div>
      {err ? (
        <p
          className="pm-banner is-bad"
          role="alert"
          style={{ maxWidth: 360, margin: '12px auto 0' }}
        >
          {err}
        </p>
      ) : null}
      <div style={{ maxWidth: 360, margin: '16px auto 0' }}>
        <button
          type="button"
          className="pm-cta is-block"
          onClick={generate}
          disabled={busy || !minor}
        >
          {busy ? 'Generando…' : 'Generar código de pago'}
        </button>
        <p className="pm-muted" style={{ textAlign: 'center' }}>
          Tarjeta •••• {card.last4 ?? '····'}. El comercio cobra el importe real, nunca más del
          máximo.
        </p>
      </div>
    </div>
  );
}

type Detector = { detect: (src: CanvasImageSource) => Promise<Array<{ rawValue: string }>> };

function Scan() {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const [state, setState] = useState<'idle' | 'on' | 'unsupported' | 'denied'>('idle');
  const [found, setFound] = useState<URL | null>(null);
  const [manual, setManual] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const stop = () => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  };
  useEffect(() => stop, []);

  const accept = (raw: string) => {
    try {
      const u = new URL(raw.trim());
      if (!/^https?:$/.test(u.protocol) || !PAY_PATH.test(u.pathname)) throw new Error('x');
      stop();
      setState('idle');
      setFound(u);
      setErr(null);
    } catch {
      setErr('Ese código no es un cobro ni un menú de Fluvia.');
    }
  };

  const start = async () => {
    const Ctor = (
      window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => Detector }
    ).BarcodeDetector;
    if (!Ctor || !navigator.mediaDevices?.getUserMedia) {
      setState('unsupported');
      return;
    }
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      });
    } catch {
      setState('denied');
      return;
    }
    setState('on');
    const v = video.current!;
    v.srcObject = stream.current;
    await v.play().catch(() => undefined);
    const det = new Ctor({ formats: ['qr_code'] });
    const tick = async () => {
      if (!stream.current) return;
      try {
        const codes = await det.detect(v);
        if (codes[0]?.rawValue) return accept(codes[0].rawValue);
      } catch {
        /* fotograma no legible */
      }
      window.setTimeout(tick, 300);
    };
    void tick();
  };

  if (found) {
    return (
      <div className="pm-card">
        <h2>¿Abrir este cobro?</h2>
        <p style={{ margin: '0 0 4px' }}>
          Destino: <strong>{found.host}</strong>
        </p>
        <p className="pm-muted">
          Comprueba que es el comercio donde estás. En la siguiente página verás el importe y eliges
          cómo pagar; nada se cobra sin tu confirmación.
        </p>
        <div style={{ display: 'grid', gap: 8 }}>
          <a className="pm-cta is-block" href={found.toString()} rel="noopener">
            Abrir cobro <Icon name="external" />
          </a>
          <button type="button" className="pm-cta is-ghost is-block" onClick={() => setFound(null)}>
            Cancelar
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 12, justifyItems: 'center' }}>
      {state === 'on' ? (
        <>
          <video
            ref={video}
            className="pm-video"
            muted
            playsInline
            aria-label="Vista de la cámara"
          />
          <button
            type="button"
            className="pm-cta is-ghost"
            onClick={() => {
              stop();
              setState('idle');
            }}
          >
            Detener cámara
          </button>
        </>
      ) : (
        <div className="pm-card" style={{ width: '100%' }}>
          <p style={{ marginTop: 0 }}>
            Escanea el QR de un cobro o del menú de una mesa. Usaremos la cámara solo mientras esta
            pantalla esté abierta.
          </p>
          <button type="button" className="pm-cta is-block" onClick={start}>
            <Icon name="camera" /> Permitir cámara y escanear
          </button>
          {state === 'unsupported' ? (
            <p className="pm-line-warn">Este navegador no puede leer QR. Pega el enlace abajo.</p>
          ) : null}
          {state === 'denied' ? (
            <p className="pm-line-warn">
              No diste permiso de cámara. Puedes pegar el enlace abajo.
            </p>
          ) : null}
        </div>
      )}
      <form
        style={{ width: '100%' }}
        onSubmit={(e) => {
          e.preventDefault();
          accept(manual);
        }}
      >
        <label
          htmlFor="pm-link"
          className="pm-option-title"
          style={{ display: 'block', marginBottom: 6 }}
        >
          O pega el enlace del cobro
        </label>
        <div className="pm-search">
          <input
            id="pm-link"
            type="url"
            inputMode="url"
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            placeholder="https://…"
          />
          <button type="submit">Abrir</button>
        </div>
      </form>
      {err ? (
        <p className="pm-banner is-bad" role="alert" style={{ width: '100%' }}>
          {err}
        </p>
      ) : null}
    </div>
  );
}
