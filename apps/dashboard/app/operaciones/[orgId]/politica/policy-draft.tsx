'use client';

import { useState } from 'react';
import { clientCall } from '../../../lib/client-call';
import { StepUpModal } from '../../../lib/step-up-modal';

/** Editor de una nueva versión (borrador). Activarla exige propuesta + aprobación de otra persona. */
export function PolicyDraft({
  orgId,
  code,
  params,
}: {
  orgId: string;
  code: string;
  params: string;
}) {
  const [text, setText] = useState(params);
  const [msg, setMsg] = useState<{ tone: string; text: string } | null>(null);
  const [stepUp, setStepUp] = useState(false);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return setMsg({ tone: 'bad', text: 'El JSON no es válido.' });
    }
    setBusy(true);
    const r = await clientCall(`/api/ops/${orgId}/policies`, {
      method: 'POST',
      body: { code, params: parsed },
    });
    setBusy(false);
    if (r.kind === 'ok') {
      setMsg({
        tone: 'ok',
        text: 'Borrador creado. Propón su activación en la tabla de versiones.',
      });
      setTimeout(() => window.location.reload(), 1000);
    } else if (r.kind === 'http' && r.code === 'mfa_step_up_required') {
      setStepUp(true);
    } else if (r.kind === 'http' && r.code === 'policy_invalid') {
      setMsg({
        tone: 'bad',
        text: 'Los parámetros no cumplen las reglas de la política (niveles A–D, topes y monedas).',
      });
    } else {
      setMsg({ tone: 'bad', text: 'No se pudo guardar el borrador.' });
    }
  };

  return (
    <div className="ox-action-form">
      <label className="ox-field">
        <span>
          Parámetros (JSON). Importes en unidades menores; multiplicadores en puntos básicos (10000
          = ×1).
        </span>
        <textarea
          rows={18}
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          style={{ fontFamily: 'ui-monospace, monospace', fontSize: '0.8rem' }}
        />
      </label>
      <div className="ox-row">
        <button type="button" className="ox-btn ox-btn-primary" onClick={save} disabled={busy}>
          {busy ? 'Guardando…' : 'Crear borrador de nueva versión'}
        </button>
      </div>
      {msg ? (
        <p className={`ox-msg ox-msg-${msg.tone}`} role={msg.tone === 'bad' ? 'alert' : 'status'}>
          {msg.text}
        </p>
      ) : null}
      {stepUp ? (
        <StepUpModal
          locale="es"
          onCancel={() => setStepUp(false)}
          onSuccess={() => {
            setStepUp(false);
            void save();
          }}
        />
      ) : null}
    </div>
  );
}
