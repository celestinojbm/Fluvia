'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { clientCall, errorMessage } from '../client-call';
import { parseMajorAmount } from '../pos-money';
import { money } from '../ui';
import { QrCode } from './qr';
import {
  newClientKey,
  vcall,
  type Enablement,
  type InPersonPayment,
  type InPersonState,
} from './api';

/**
 * «Cobrar» en el teléfono del independiente (taxista, técnico…): importe,
 * moneda, concepto opcional → «Acercar tarjeta» → resultado VERIFICADO por el
 * servidor → recibo. Alternativas: QR/enlace (funciona hoy) y lector externo.
 *
 * Honestidad por diseño:
 *  - Un navegador no es un terminal certificado: el servidor lo declara
 *    incompatible. Tap to Pay real exige la app nativa con el SDK de un
 *    proveedor habilitado en el país (hoy pendiente).
 *  - En sandbox existe un SIMULADOR explícito: todo lo que produce lleva la
 *    marca «Simulado» y el resultado lo decide el proveedor sandbox del
 *    servidor, nunca esta pantalla.
 *  - No hay campos de tarjeta: Fluvia no captura PAN ni CVV.
 */

type Step =
  | { kind: 'form' }
  | { kind: 'device'; verdict: DeviceVerdict }
  | { kind: 'charge'; payment: InPersonPayment }
  | { kind: 'link'; url: string; amount: number; currency: string };

interface DeviceVerdict {
  capability: 'compatible' | 'incompatible' | 'unknown';
  reasons: string[];
}

const REASON_TEXT: Record<string, string> = {
  web_is_not_a_certified_terminal:
    'Un navegador web no es un terminal de pago certificado (Web NFC no acepta tarjetas EMV).',
  native_app_required: 'Tap to Pay necesita la app nativa de Fluvia con el SDK del proveedor.',
  android_13_required: 'Se requiere Android 13 o superior.',
  nfc_missing: 'El teléfono no tiene NFC o está desactivado.',
  unsupported_os: 'Sistema operativo no admitido.',
  os_version_unknown: 'No pudimos confirmar la versión del sistema.',
  iphone_model_unknown: 'No pudimos confirmar el modelo de iPhone (XS o posterior).',
};

const STATE_TEXT: Record<InPersonState, { title: string; body: string; tone: string }> = {
  device_incompatible: {
    title: 'Dispositivo incompatible',
    body: 'Este dispositivo no puede leer tarjetas. Usa el QR o un lector externo.',
    tone: 'bad',
  },
  preparing: { title: 'Preparando dispositivo', body: 'Un momento…', tone: 'info' },
  ready: {
    title: 'Listo para cobrar',
    body: 'Pide al cliente su tarjeta o teléfono.',
    tone: 'info',
  },
  waiting_card: {
    title: 'Acerque la tarjeta',
    body: 'El cliente acerca su tarjeta o billetera al teléfono.',
    tone: 'lime',
  },
  processing: {
    title: 'Procesando con el proveedor',
    body: 'No retires el teléfono ni cobres de nuevo.',
    tone: 'info',
  },
  approved: { title: 'Pago aprobado', body: 'Confirmado por el proveedor.', tone: 'ok' },
  declined: {
    title: 'Pago rechazado',
    body: 'El proveedor no aprobó el pago. No se cobró nada.',
    tone: 'bad',
  },
  canceled: { title: 'Cobro cancelado', body: 'No se cobró nada.', tone: 'neutral' },
  uncertain: {
    title: 'Resultado pendiente de confirmar',
    body: 'El proveedor aún no confirma. NO cobres de nuevo: Fluvia lo verificará y esta pantalla se actualizará.',
    tone: 'warn',
  },
};

function detectPlatform(): { label: string; webNfc: boolean } {
  if (typeof navigator === 'undefined') return { label: 'desconocido', webNfc: false };
  const ua = navigator.userAgent;
  const webNfc = 'NDEFReader' in window;
  const android = /Android (\d+)/.exec(ua);
  if (android) return { label: `Android ${android[1]} (navegador)`, webNfc };
  if (/iPhone|iPad/.test(ua)) return { label: 'iPhone/iPad (navegador)', webNfc };
  return { label: 'Ordenador (navegador)', webNfc };
}

export function CobrarWorkspace({
  orgId,
  merchantId,
  currencies,
  enablement: initialEnablement,
  sandbox,
  canConfigure,
}: {
  orgId: string;
  merchantId: string | null;
  currencies: string[];
  enablement: Enablement;
  sandbox: boolean;
  canConfigure: boolean;
}) {
  const [enablement] = useState(initialEnablement);
  const [amountText, setAmountText] = useState('');
  const [currency, setCurrency] = useState(currencies[0] ?? 'USD');
  const [concept, setConcept] = useState('');
  const [step, setStep] = useState<Step>({ kind: 'form' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const keyRef = useRef<string | null>(null);
  const live = useRef<HTMLParagraphElement>(null);

  const parsed = parseMajorAmount(amountText, currency);
  const enabled = enablement.status === 'enabled';
  const simulatorAvailable = sandbox && enabled && enablement.provider === 'sandbox_simulator';

  const reset = () => {
    setStep({ kind: 'form' });
    setError(null);
    keyRef.current = null;
  };

  async function checkDevice() {
    if (!parsed.ok) return;
    setBusy(true);
    setError(null);
    // La pantalla corre en un navegador: se informa como tal (el servidor decide).
    const r = await vcall<DeviceVerdict>(orgId, 'in-person/devices', {
      method: 'POST',
      body: { platform: 'web', nfc: detectPlatform().webNfc },
    });
    setBusy(false);
    if (r.kind !== 'ok') return setError(errorMessage(r));
    setStep({ kind: 'device', verdict: r.body });
  }

  async function startSimulated() {
    if (!parsed.ok) return;
    setBusy(true);
    setError(null);
    // Misma clave en reintentos: si se pierde la respuesta, el servidor
    // devuelve el MISMO cobro en lugar de crear otro.
    keyRef.current ??= newClientKey('cobrar');
    const created = await vcall<InPersonPayment>(orgId, 'in-person/payments', {
      method: 'POST',
      body: {
        method: 'simulator',
        client_key: keyRef.current,
        source: { kind: 'amount', amount: parsed.minor, currency, concept: concept || null },
      },
    });
    if (created.kind !== 'ok') {
      setBusy(false);
      return setError(errorMessage(created));
    }
    let p = created.body;
    // Preparación del dispositivo: la app SOLO avanza estos pasos.
    const advance = async (to: 'ready' | 'waiting_card') => {
      const r = await vcall<InPersonPayment>(orgId, `in-person/payments/${p.id}/state`, {
        method: 'POST',
        body: { to, expected_version: p.version },
      });
      if (r.kind === 'ok') p = r.body;
      else setError(errorMessage(r));
    };
    if (p.state === 'preparing') await advance('ready');
    if (p.state === 'ready') await advance('waiting_card');
    setBusy(false);
    setStep({ kind: 'charge', payment: p });
  }

  async function simulate(outcome: 'approve' | 'decline' | 'timeout' | 'pending') {
    if (step.kind !== 'charge') return;
    setBusy(true);
    setError(null);
    const r = await vcall<InPersonPayment>(
      orgId,
      `in-person/payments/${step.payment.id}/simulate`,
      {
        method: 'POST',
        body: { outcome },
      }
    );
    setBusy(false);
    if (r.kind === 'ok') setStep({ kind: 'charge', payment: r.body });
    else {
      setError(errorMessage(r));
      void refresh();
    }
  }

  async function cancel() {
    if (step.kind !== 'charge') return;
    const r = await vcall<InPersonPayment>(orgId, `in-person/payments/${step.payment.id}/state`, {
      method: 'POST',
      body: { to: 'canceled', expected_version: step.payment.version },
    });
    if (r.kind === 'ok') setStep({ kind: 'charge', payment: r.body });
    else setError(errorMessage(r));
  }

  const refresh = useCallback(async () => {
    if (step.kind !== 'charge') return;
    const r = await vcall<InPersonPayment>(orgId, `in-person/payments/${step.payment.id}`);
    if (r.kind === 'ok') setStep({ kind: 'charge', payment: r.body });
  }, [orgId, step]);

  // Incierto o procesando: el servidor resuelve (webhook del proveedor); se
  // consulta cada pocos segundos sin repetir el cobro.
  const watching =
    step.kind === 'charge' && ['processing', 'uncertain'].includes(step.payment.state);
  useEffect(() => {
    if (!watching) return;
    const t = setInterval(() => void refresh(), 3000);
    return () => clearInterval(t);
  }, [watching, refresh]);

  useEffect(() => {
    if (step.kind === 'charge' && live.current) {
      live.current.textContent = STATE_TEXT[step.payment.state].title;
    }
  }, [step]);

  async function payByLink() {
    if (!parsed.ok || !merchantId) return;
    setBusy(true);
    setError(null);
    const r = await clientCall<{ id: string; url: string; amount: number; currency: string }>(
      `/api/orgs/${orgId}/payment-links`,
      {
        method: 'POST',
        idempotencyKey: newClientKey('qr'),
        body: {
          merchant_id: merchantId,
          amount: parsed.minor,
          currency,
          description: concept || 'Cobro',
          single_charge: true,
        },
      }
    );
    setBusy(false);
    if (r.kind !== 'ok') return setError(errorMessage(r));
    setStep({ kind: 'link', url: r.body.url, amount: r.body.amount, currency: r.body.currency });
  }

  const platform = typeof window === 'undefined' ? null : detectPlatform();

  return (
    <div className="vn-cobrar">
      <p ref={live} className="fx-sr" aria-live="polite" />
      <EnablementBanner enablement={enablement} canConfigure={canConfigure} orgId={orgId} />

      {step.kind === 'form' ? (
        <form
          className="vn-card vn-amount"
          onSubmit={(e) => {
            e.preventDefault();
            void checkDevice();
          }}
        >
          <label className="vn-amount-field">
            <span>Importe</span>
            <input
              inputMode="decimal"
              autoComplete="off"
              placeholder="0,00"
              value={amountText}
              onChange={(e) => setAmountText(e.target.value)}
              aria-invalid={amountText !== '' && !parsed.ok}
              aria-describedby="amount-help"
            />
          </label>
          <p id="amount-help" className="vn-help">
            {amountText && parsed.ok
              ? `Cobrarás ${money(parsed.minor, currency)}`
              : 'Escribe el importe en unidades (por ejemplo 12,50).'}
          </p>
          <div className="vn-row">
            <label className="fx-field">
              <span>Moneda</span>
              <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
                {currencies.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <label className="fx-field vn-grow">
              <span>Concepto (opcional)</span>
              <input
                maxLength={80}
                value={concept}
                onChange={(e) => setConcept(e.target.value)}
                placeholder="Carrera, reparación…"
              />
            </label>
          </div>
          <button
            type="submit"
            className="vn-cta"
            disabled={!parsed.ok || busy || !enabled}
            aria-describedby={!enabled ? 'enable-status' : undefined}
          >
            Acercar tarjeta
          </button>
          <div className="vn-alt">
            <button
              type="button"
              className="fx-btn"
              disabled={!parsed.ok || busy || !merchantId}
              onClick={() => void payByLink()}
            >
              Cobrar con QR o enlace
            </button>
            <button type="button" className="fx-btn" disabled aria-describedby="reader-help">
              Lector externo
            </button>
          </div>
          <p id="reader-help" className="vn-help">
            Lector externo: ningún lector está configurado para tu cuenta. Ingresar la tarjeta a
            mano solo sería posible dentro del componente seguro de un proveedor habilitado: Fluvia
            nunca pide número de tarjeta ni CVV.
          </p>
        </form>
      ) : null}

      {step.kind === 'device' ? (
        <section className="vn-card" aria-labelledby="dev-title">
          <h2 id="dev-title">
            {step.verdict.capability === 'compatible'
              ? 'Teléfono compatible'
              : 'Este dispositivo no puede leer tarjetas'}
          </h2>
          {platform ? (
            <p className="vn-help">
              Detectado: {platform.label}. Web NFC{' '}
              {platform.webNfc ? 'disponible' : 'no disponible'} en este navegador.
            </p>
          ) : null}
          <ul className="vn-reasons">
            {step.verdict.reasons.map((r) => (
              <li key={r}>{REASON_TEXT[r] ?? r}</li>
            ))}
          </ul>
          <p>
            Tap to Pay real está <strong>pendiente</strong>: requiere la app nativa con el SDK de un
            proveedor que opere en tu país, sus credenciales y un teléfono compatible.
          </p>
          <div className="vn-alt">
            <button
              type="button"
              className="fx-btn fx-btn-primary"
              onClick={() => void payByLink()}
            >
              Cobrar con QR o enlace
            </button>
            {simulatorAvailable ? (
              <button
                type="button"
                className="fx-btn fx-btn-sim"
                disabled={busy}
                onClick={() => void startSimulated()}
              >
                Simular cobro (sandbox)
              </button>
            ) : null}
            <button type="button" className="fx-btn fx-btn-ghost" onClick={reset}>
              Volver
            </button>
          </div>
        </section>
      ) : null}

      {step.kind === 'charge' ? (
        <ChargeView
          payment={step.payment}
          busy={busy}
          onSimulate={(o) => void simulate(o)}
          onCancel={() => void cancel()}
          onRefresh={() => void refresh()}
          onNew={reset}
        />
      ) : null}

      {step.kind === 'link' ? (
        <section className="vn-card vn-center" aria-labelledby="qr-title">
          <h2 id="qr-title">Escanea para pagar {money(step.amount, step.currency)}</h2>
          <QrCode
            value={step.url}
            label={`Código QR del enlace de pago de ${money(step.amount, step.currency)}`}
          />
          <p className="vn-link">
            <a href={step.url} target="_blank" rel="noreferrer">
              {step.url}
            </a>
          </p>
          <p className="vn-help">
            Venta de cobro único: el cliente paga desde su teléfono y el resultado aparece en Ventas
            y Pagos cuando el proveedor lo confirma.
          </p>
          <button type="button" className="fx-btn" onClick={reset}>
            Nuevo cobro
          </button>
        </section>
      ) : null}

      {error ? (
        <p className="vn-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function ChargeView({
  payment: p,
  busy,
  onSimulate,
  onCancel,
  onRefresh,
  onNew,
}: {
  payment: InPersonPayment;
  busy: boolean;
  onSimulate: (o: 'approve' | 'decline' | 'timeout' | 'pending') => void;
  onCancel: () => void;
  onRefresh: () => void;
  onNew: () => void;
}) {
  const s = STATE_TEXT[p.state];
  const final = ['approved', 'declined', 'canceled', 'device_incompatible'].includes(p.state);
  return (
    <section className="vn-card vn-charge" data-tone={s.tone} aria-labelledby="charge-title">
      {p.simulated ? <p className="vn-sim-badge">Simulado · sin tarjeta real</p> : null}
      <p className="vn-charge-amount">{money(p.amount, p.currency)}</p>
      {p.concept ? <p className="vn-help">{p.concept}</p> : null}
      <h2 id="charge-title">{s.title}</h2>
      <p>
        {p.state === 'approved' && p.simulated
          ? 'Confirmado por el proveedor SANDBOX (simulado): no se leyó ninguna tarjeta real.'
          : s.body}
      </p>

      {p.state === 'waiting_card' && p.simulated ? (
        <div className="vn-sim-panel" role="group" aria-label="Simulador del proveedor sandbox">
          <p>
            <strong>Simulador:</strong> no hay lectura NFC. Elige qué responde el proveedor sandbox;
            el servidor confirma el resultado.
          </p>
          <div className="vn-alt">
            <button
              type="button"
              className="fx-btn fx-btn-sim"
              disabled={busy}
              onClick={() => onSimulate('approve')}
            >
              Proveedor aprueba
            </button>
            <button
              type="button"
              className="fx-btn fx-btn-sim"
              disabled={busy}
              onClick={() => onSimulate('decline')}
            >
              Proveedor rechaza
            </button>
            <button
              type="button"
              className="fx-btn fx-btn-sim"
              disabled={busy}
              onClick={() => onSimulate('pending')}
            >
              Queda pendiente
            </button>
            <button
              type="button"
              className="fx-btn fx-btn-sim"
              disabled={busy}
              onClick={() => onSimulate('timeout')}
            >
              Proveedor no responde
            </button>
          </div>
        </div>
      ) : null}

      {p.state === 'approved' && p.receipt ? (
        <dl className="vn-receipt" aria-label="Recibo">
          <div>
            <dt>Importe</dt>
            <dd>{money(p.receipt.amount, p.receipt.currency)}</dd>
          </div>
          {p.receipt.concept ? (
            <div>
              <dt>Concepto</dt>
              <dd>{p.receipt.concept}</dd>
            </div>
          ) : null}
          <div>
            <dt>Referencia</dt>
            <dd className="vn-mono">{p.receipt.payment_intent_id}</dd>
          </div>
          <div>
            <dt>Medio</dt>
            <dd>
              {p.receipt.simulated
                ? 'Simulador sandbox (sin tarjeta real)'
                : 'Tarjeta sin contacto'}
            </dd>
          </div>
        </dl>
      ) : null}

      <div className="vn-alt">
        {['preparing', 'ready', 'waiting_card'].includes(p.state) ? (
          <button type="button" className="fx-btn fx-btn-ghost" onClick={onCancel}>
            Cancelar cobro
          </button>
        ) : null}
        {['processing', 'uncertain'].includes(p.state) ? (
          <button type="button" className="fx-btn" onClick={onRefresh}>
            Consultar ahora
          </button>
        ) : null}
        {p.state === 'approved' ? (
          <button type="button" className="fx-btn" onClick={() => window.print()}>
            Imprimir o guardar recibo
          </button>
        ) : null}
        {final ? (
          <button type="button" className="fx-btn fx-btn-primary" onClick={onNew}>
            Nuevo cobro
          </button>
        ) : null}
      </div>
    </section>
  );
}

export function EnablementBanner({
  enablement: e,
  canConfigure,
  orgId,
}: {
  enablement: Enablement;
  canConfigure: boolean;
  orgId: string;
}) {
  if (e.status === 'enabled') {
    return (
      <p id="enable-status" className="vn-pill" data-tone="ok">
        Cobro presencial habilitado ·{' '}
        {e.provider === 'sandbox_simulator' ? 'proveedor simulado (sandbox)' : e.provider}
      </p>
    );
  }
  const label = {
    pending: 'pendiente de habilitación',
    restricted: 'restringido',
    suspended: 'suspendido',
  }[e.status];
  const missing = e.requirements.filter((r) => !r.done);
  return (
    <div
      id="enable-status"
      className="fx-callout"
      data-tone={e.status === 'pending' ? 'warn' : 'bad'}
      role="status"
    >
      <div>
        <p>
          <strong>Cobro presencial {label}.</strong> Tu cuenta no puede cobrar con tarjeta hasta que
          el proveedor la habilite.
        </p>
        {e.reason ? <p>Motivo: {e.reason}</p> : null}
        {missing.length ? (
          <ul>
            {missing.map((r) => (
              <li key={r.id}>{r.label}</li>
            ))}
          </ul>
        ) : null}
        {canConfigure ? (
          <p>
            <a href={`/o/${orgId}/negocio#habilitacion`}>Completar la habilitación</a>
          </p>
        ) : null}
      </div>
    </div>
  );
}
