'use client';

import { useState } from 'react';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../../../lib/csrf-header';

export function LogoutButton() {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="px-btn"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await fetch('/api/personal-session', {
          method: 'DELETE',
          headers: { [CSRF_HEADER]: CSRF_HEADER_VALUE },
        }).catch(() => undefined);
        window.location.href = '/personal/entrar';
      }}
    >
      {busy ? 'Cerrando…' : 'Cerrar sesión'}
    </button>
  );
}
