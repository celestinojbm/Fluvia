'use client';

import { Icon } from '../../lib/icons';
import { useId, useRef, useState, type FormEvent } from 'react';
import { clientCall } from '../../lib/client-call';
import { StepUpModal } from '../../lib/step-up-modal';

/**
 * Acción de operador (Fluvia Operaciones). Declarativa para poder usarse desde
 * server components: campos → cuerpo JSON (importes convertidos a unidades
 * menores sin coma flotante; `extra` se añade tal cual). Si el servidor exige
 * step-up (`mfa_step_up_required`), pide la contraseña y reintenta UNA vez.
 * Motivo obligatorio en las acciones sensibles; la API decide permisos.
 */
export interface ActionField {
  name: string;
  label: string;
  type?: 'text' | 'amount' | 'select' | 'textarea' | 'datetime';
  options?: { value: string; label: string }[];
  required?: boolean;
  placeholder?: string;
  defaultValue?: string;
  /** El valor es una lista separada por comas (se envía como array). */
  list?: boolean;
}

function toMinor(text: string): string | null {
  const t = text.trim().replace(/\s/g, '').replace(',', '.');
  if (!/^\d{1,13}(\.\d{0,2})?$/.test(t)) return null;
  const [w, f = ''] = t.split('.');
  return (BigInt(w!) * 100n + BigInt((f + '00').slice(0, 2) || '0')).toString();
}

const MESSAGES: Record<string, string> = {
  insufficient_permissions: 'Tu rol no permite esta acción.',
  four_eyes_required: 'Otra persona debe aprobar: no puedes aprobar lo que propusiste.',
  invalid_state_transition:
    'La acción no aplica al estado actual. Recarga para ver el estado vigente.',
  amount_exceeds_allowed: 'El importe supera lo permitido (garantía, política o deuda vencida).',
  collateral_committed: 'Esa garantía respalda exposición viva.',
  insufficient_collateral: 'No hay garantía bloqueada suficiente.',
  policy_invalid: 'Los parámetros de la política no son válidos.',
  validation_error: 'Revisa los datos.',
  not_found: 'No encontrado.',
};

export function OpsAction({
  orgId,
  path,
  label,
  tone = 'default',
  fields = [],
  reason = true,
  extra = {},
  confirm,
  success = 'Hecho.',
}: {
  orgId: string;
  path: string;
  label: string;
  tone?: 'default' | 'primary' | 'danger';
  fields?: ActionField[];
  reason?: boolean;
  extra?: Record<string, unknown>;
  confirm?: string;
  success?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stepUp, setStepUp] = useState(false);
  const [msg, setMsg] = useState<{ tone: string; text: string } | null>(null);
  const pending = useRef<Record<string, unknown> | null>(null);

  const send = async (body: Record<string, unknown>) => {
    setBusy(true);
    setMsg(null);
    const r = await clientCall<unknown>(`/api/ops/${orgId}/${path}`, { method: 'POST', body });
    setBusy(false);
    if (r.kind === 'ok') {
      setMsg({ tone: 'ok', text: success });
      setTimeout(() => window.location.reload(), 900);
      return;
    }
    if (r.kind === 'http' && r.status === 403 && r.code === 'mfa_step_up_required') {
      pending.current = body;
      setStepUp(true);
      return;
    }
    if (r.kind === 'network') {
      setMsg({
        tone: 'warn',
        text: 'Sin respuesta: no sabemos si se aplicó. Recarga y comprueba antes de repetir.',
      });
      return;
    }
    if (r.status === 401)
      return setMsg({ tone: 'bad', text: 'Tu sesión caducó. Vuelve a iniciar sesión.' });
    setMsg({
      tone: 'bad',
      text: MESSAGES[r.code ?? ''] ?? `No se pudo completar (${r.code ?? r.status}).`,
    });
  };

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body: Record<string, unknown> = { ...extra };
    for (const fd of fields) {
      const raw = String(f.get(fd.name) ?? '').trim();
      if (!raw) continue;
      if (fd.type === 'amount') {
        const m = toMinor(raw);
        if (!m) return setMsg({ tone: 'bad', text: `Importe inválido en «${fd.label}».` });
        body[fd.name] = m;
      } else if (fd.type === 'datetime') {
        body[fd.name] = new Date(raw).toISOString();
      } else if (fd.list) {
        body[fd.name] = raw
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean);
      } else {
        body[fd.name] = raw;
      }
    }
    if (reason)
      body[path.endsWith('/resolve') ? 'resolution' : 'reason'] = String(
        f.get('__reason') ?? ''
      ).trim();
    if (confirm && !window.confirm(confirm)) return;
    await send(body);
  };

  return (
    <div className="ox-action">
      {!open ? (
        <button
          type="button"
          className={`ox-btn ox-btn-${tone}`}
          onClick={() => setOpen(true)}
          aria-expanded={false}
          aria-controls={id}
          data-sensitive={reason ? 'true' : undefined}
        >
          {reason ? <Icon name="lock" size={15} /> : null}
          {label}
        </button>
      ) : (
        <form
          id={id}
          className="ox-action-form"
          data-tone={tone}
          onSubmit={submit}
          aria-label={label}
        >
          <p className="ox-action-title">{label}</p>
          {fields.map((fd) => (
            <label key={fd.name} className="ox-field">
              <span>{fd.label}</span>
              {fd.type === 'select' ? (
                <select
                  name={fd.name}
                  defaultValue={fd.defaultValue}
                  required={fd.required !== false}
                >
                  {fd.options!.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : fd.type === 'textarea' ? (
                <textarea
                  name={fd.name}
                  rows={4}
                  required={fd.required !== false}
                  placeholder={fd.placeholder}
                  defaultValue={fd.defaultValue}
                />
              ) : (
                <input
                  name={fd.name}
                  type={fd.type === 'datetime' ? 'datetime-local' : 'text'}
                  inputMode={fd.type === 'amount' ? 'decimal' : undefined}
                  required={fd.required !== false}
                  placeholder={fd.placeholder}
                  defaultValue={fd.defaultValue}
                />
              )}
            </label>
          ))}
          {reason ? (
            <label className="ox-field">
              <span>Motivo (queda en la auditoría)</span>
              <input name="__reason" required minLength={3} maxLength={280} />
            </label>
          ) : null}
          <div className="ox-row">
            <button
              type="submit"
              className={`ox-btn ox-btn-${tone === 'default' ? 'primary' : tone}`}
              disabled={busy}
            >
              {busy ? 'Aplicando…' : 'Confirmar'}
            </button>
            <button
              type="button"
              className="ox-btn"
              onClick={() => {
                setOpen(false);
                setMsg(null);
              }}
              disabled={busy}
            >
              Cancelar
            </button>
          </div>
          {msg ? (
            <p
              className={`ox-msg ox-msg-${msg.tone}`}
              role={msg.tone === 'bad' ? 'alert' : 'status'}
            >
              {msg.text}
            </p>
          ) : null}
        </form>
      )}
      {stepUp ? (
        <StepUpModal
          locale="es"
          onCancel={() => {
            setStepUp(false);
            setMsg({ tone: 'warn', text: 'Acción cancelada: requiere confirmar tu contraseña.' });
          }}
          onSuccess={() => {
            setStepUp(false);
            if (pending.current) void send(pending.current);
          }}
        />
      ) : null}
    </div>
  );
}
