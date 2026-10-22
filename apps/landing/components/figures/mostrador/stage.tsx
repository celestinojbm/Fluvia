'use client';

import dynamic from 'next/dynamic';
import { useEffect, useState, type ReactNode } from 'react';

const MostradorLive = dynamic(
  () => import('./live').then((mod) => mod.MostradorLive),
  { ssr: false }
);

/**
 * El póster (reposo, sin motion) es lo que llega en el HTML.
 * La figura viva solo entra en el cliente, y no entra si la persona
 * pidió menos movimiento.
 */
export function MostradorStage({ poster }: { poster: ReactNode }) {
  const [live, setLive] = useState(false);

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (media.matches) return;
    setLive(true);
    const onChange = () => setLive(!media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  return live ? <MostradorLive /> : poster;
}
