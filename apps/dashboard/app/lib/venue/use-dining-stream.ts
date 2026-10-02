'use client';

import { useEffect, useRef, useState } from 'react';
import { vpath } from './api';

/**
 * Avisos en vivo de la sucursal (SSE por el BFF). Cada aviso solo dispara
 * `onChange`: quien lo usa vuelve a leer del servidor (verdad), así que un
 * aviso perdido o duplicado no corrompe la pantalla. Respaldo por sondeo.
 */
export function useDiningStream(
  orgId: string,
  branchId: string | null,
  onChange: () => void,
  fallbackMs = 20_000
): 'connecting' | 'live' | 'reconnecting' {
  const [conn, setConn] = useState<'connecting' | 'live' | 'reconnecting'>('connecting');
  const cb = useRef(onChange);
  cb.current = onChange;
  useEffect(() => {
    if (!branchId) return;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const fire = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => cb.current(), 150);
    };
    const es = new EventSource(vpath(orgId, `dining/stream?branch_id=${branchId}`));
    es.addEventListener('ready', () => {
      setConn('live');
      fire();
    });
    es.addEventListener('changed', fire);
    es.addEventListener('ping', () => setConn('live'));
    es.onerror = () => setConn('reconnecting');
    const poll = setInterval(() => cb.current(), fallbackMs);
    return () => {
      es.close();
      clearInterval(poll);
      if (debounce) clearTimeout(debounce);
    };
  }, [orgId, branchId, fallbackMs]);
  return conn;
}
