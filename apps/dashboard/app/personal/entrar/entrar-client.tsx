'use client';

import { safePersonalNext } from '../lib/next-path';
import { useState, type FormEvent } from 'react';
import { FluviaLogo } from '../../lib/brand';
import { clientCall } from '../../lib/client-call';
import { personalError } from '../lib/client';

export function EntrarClient({
  expired,
  initialMode,
}: {
  expired: boolean;
  initialMode: 'login' | 'register';
}) {
  const [mode, setMode] = useState<'login' | 'register'>(initialMode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    const r = await clientCall('/api/personal-session', {
      method: 'POST',
      body: {
        mode,
        email: f.get('email'),
        password: f.get('password'),
        display_name: f.get('display_name'),
        synthetic_risk_profile: f.get('profile') ?? undefined,
      },
    });
    setBusy(false);
    if (r.kind === 'ok') {
      // Vuelve al enlace profundo pedido (solo rutas internas de Personal).
      window.location.href = safePersonalNext(
        new URLSearchParams(window.location.search).get('next')
      );
      return;
    }
    setError(personalError(r));
  };

  return (
    <div className="px-auth">
      <p className="px-brand">
        <FluviaLogo height={26} label="Personal" />
      </p>
      {expired ? (
        <p className="px-alert px-alert-warn" role="status">
          Tu sesión caducó. Entra de nuevo para continuar.
        </p>
      ) : null}
      <div className="px-tabs-inline" role="group" aria-label="Acceso">
        <button type="button" aria-pressed={mode === 'login'} onClick={() => setMode('login')}>
          Entrar
        </button>
        <button
          type="button"
          aria-pressed={mode === 'register'}
          onClick={() => setMode('register')}
        >
          Crear cuenta
        </button>
      </div>
      <h1 style={{ fontSize: '1.4rem', margin: '0 0 12px' }}>
        {mode === 'login' ? 'Entra a tu cuenta' : 'Crea tu cuenta de prueba'}
      </h1>
      <form className="px-form" onSubmit={submit} noValidate={false}>
        {mode === 'register' ? (
          <div className="px-field">
            <label htmlFor="px-name">Nombre</label>
            <input id="px-name" name="display_name" required maxLength={80} autoComplete="name" />
          </div>
        ) : null}
        <div className="px-field">
          <label htmlFor="px-email">Correo</label>
          <input id="px-email" name="email" type="email" required autoComplete="email" />
        </div>
        <div className="px-field">
          <label htmlFor="px-pass">Contraseña</label>
          <input
            id="px-pass"
            name="password"
            type="password"
            required
            minLength={mode === 'register' ? 12 : 1}
            autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
          />
          {mode === 'register' ? <span className="px-hint">Mínimo 12 caracteres.</span> : null}
        </div>
        {mode === 'register' ? (
          <div className="px-field">
            <label htmlFor="px-profile">Perfil de riesgo de prueba</label>
            <select id="px-profile" name="profile" defaultValue="B">
              <option value="A">A — prueba favorable</option>
              <option value="B">B — prueba estándar</option>
              <option value="C">C — prueba prudente</option>
              <option value="D">D — prueba sin crédito</option>
            </select>
            <span className="px-hint">
              Dato SINTÉTICO para el entorno de prueba: Fluvia no verifica ingresos, identidad ni
              historial.
            </span>
          </div>
        ) : null}
        {error ? (
          <p className="px-alert px-alert-bad" role="alert">
            {error}
          </p>
        ) : null}
        <button className="px-btn px-btn-primary" type="submit" disabled={busy}>
          {busy ? 'Un momento…' : mode === 'login' ? 'Entrar' : 'Crear cuenta'}
        </button>
      </form>
      <p className="px-muted" style={{ marginTop: 16 }}>
        Entorno de prueba con datos sintéticos. Sin dinero real.
      </p>
    </div>
  );
}
