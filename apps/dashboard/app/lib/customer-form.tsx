'use client';

import { useRef, useState } from 'react';
import { clientCall, errorMessage } from './client-call';
import type { Customer } from './commerce-api';

/**
 * Ficha mínima de cliente (alta y edición). Datos SINTÉTICOS en la demo: no
 * introducir datos personales reales en el sandbox.
 */
export function CustomerForm({
  orgId,
  customer,
  canEdit,
}: {
  orgId: string;
  customer?: Customer;
  canEdit: boolean;
}) {
  const editing = customer !== undefined;
  const [name, setName] = useState(customer?.name ?? '');
  const [email, setEmail] = useState(customer?.email ?? '');
  const [phone, setPhone] = useState(customer?.phone ?? '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const lock = useRef(false);
  const msgRef = useRef<HTMLDivElement>(null);
  const empty = !name.trim() && !email.trim() && !phone.trim();

  async function submit() {
    if (lock.current || !canEdit) return;
    if (empty) {
      setMsg({ tone: 'bad', text: 'Indica al menos nombre, email o teléfono.' });
      return;
    }
    lock.current = true;
    setBusy(true);
    try {
      const body = {
        name: name.trim() || null,
        email: email.trim() || null,
        phone: phone.trim() || null,
      };
      const r = editing
        ? await clientCall<Customer>(
            `/api/orgs/${encodeURIComponent(orgId)}/customers/${customer!.id}`,
            {
              method: 'PATCH',
              body,
            }
          )
        : await clientCall<Customer>(`/api/orgs/${encodeURIComponent(orgId)}/customers`, {
            method: 'POST',
            body: Object.fromEntries(Object.entries(body).filter(([, v]) => v !== null)),
          });
      if (r.kind === 'ok') {
        if (!editing) {
          window.location.assign(`/o/${orgId}/customers/${r.body.id}`);
          return;
        }
        setMsg({ tone: 'ok', text: 'Ficha actualizada.' });
      } else setMsg({ tone: 'bad', text: errorMessage(r) });
    } finally {
      lock.current = false;
      setBusy(false);
      setTimeout(() => msgRef.current?.focus(), 0);
    }
  }

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div ref={msgRef} tabIndex={-1}>
        {msg ? (
          <div
            className="fx-callout"
            data-tone={msg.tone}
            role={msg.tone === 'bad' ? 'alert' : 'status'}
          >
            <p>{msg.text}</p>
          </div>
        ) : null}
      </div>
      <fieldset disabled={!canEdit || busy} style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="sr-only">{editing ? 'Editar cliente' : 'Nuevo cliente'}</legend>
        <div className="fx-field">
          <label htmlFor="cu-name">Nombre</label>
          <input
            id="cu-name"
            className="fx-input"
            maxLength={200}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="fx-row">
          <div className="fx-field">
            <label htmlFor="cu-email">Email</label>
            <input
              id="cu-email"
              type="email"
              className="fx-input"
              maxLength={254}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="fx-field">
            <label htmlFor="cu-phone">Teléfono</label>
            <input
              id="cu-phone"
              className="fx-input"
              maxLength={40}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </div>
        </div>
        <p className="fx-hint" style={{ marginBottom: 12 }}>
          Sandbox: usa datos de prueba, no datos personales reales.
        </p>
        {canEdit ? (
          <button type="submit" className="fx-btn fx-btn-primary">
            {busy ? 'Guardando…' : editing ? 'Guardar cambios' : 'Crear cliente'}
          </button>
        ) : (
          <p className="fx-hint">Tu rol no puede editar clientes.</p>
        )}
      </fieldset>
    </form>
  );
}
