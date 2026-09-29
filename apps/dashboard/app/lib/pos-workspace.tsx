'use client';

import { useCallback, useRef, useState } from 'react';
import type { Locale } from '../messages';
import type { Merchant } from './api';
import type { SalePhase } from './pos-contract';
import type { RecentChargesResult } from './pos-reads';
import { PosRecentCharges } from './pos-recent';
import { PosTerminal, type PosActivity } from './pos-terminal';

/**
 * Contenedor cliente del POS: une el terminal y «Cobros recientes» para que
 *  - el panel se refresque cuando el terminal abre un cobro o ve un cambio de
 *    fase (sin exigir recargar la página), y
 *  - «Seguir» abra el cobro en el terminal de esta misma pantalla, salvo que
 *    haya una venta sin cerrar (se perdería su clave de idempotencia).
 */
export function PosWorkspace({
  orgId,
  locale,
  merchants,
  allMerchants,
  canCharge,
  resume,
  recent,
}: {
  orgId: string;
  locale: Locale;
  merchants: Merchant[];
  allMerchants: Array<{ id: string; name: string }>;
  canCharge: boolean;
  resume?: { sessionId: string; linkId: string | null };
  recent: RecentChargesResult;
}) {
  const [track, setTrack] = useState<{
    sessionId: string;
    linkId: string | null;
    nonce: number;
  } | null>(resume ? { ...resume, nonce: 0 } : null);
  const [signal, setSignal] = useState(0);
  const [activity, setActivity] = useState<PosActivity>({
    sessionId: resume?.sessionId ?? null,
    phase: null,
    locked: false,
  });

  // Refresca la lista solo cuando cambia el cobro seguido o su fase
  // verificada (no al montar sin cobro, ni por el bloqueo del borrador).
  const last = useRef<{ sessionId: string | null; phase: SalePhase | null }>({
    sessionId: null,
    phase: null,
  });
  const onActivity = useCallback((ev: PosActivity) => {
    setActivity(ev);
    const prev = last.current;
    last.current = { sessionId: ev.sessionId, phase: ev.phase };
    if (ev.sessionId !== null && (ev.sessionId !== prev.sessionId || ev.phase !== prev.phase)) {
      setSignal((n) => n + 1);
    }
  }, []);

  const onTrack = useCallback(
    (sessionId: string) => {
      if (activity.locked) return;
      setTrack((prev) => ({ sessionId, linkId: null, nonce: (prev?.nonce ?? 0) + 1 }));
      try {
        const q = new URLSearchParams();
        if (locale === 'en') q.set('lang', 'en');
        q.set('session', sessionId);
        window.history.replaceState(null, '', `/o/${orgId}/pos?${q.toString()}`);
      } catch {
        /* sin history */
      }
    },
    [activity.locked, locale, orgId]
  );

  return (
    <div className="pos-grid">
      <PosTerminal
        key={track?.nonce ?? 'new'}
        orgId={orgId}
        locale={locale}
        merchants={merchants}
        canCharge={canCharge}
        resume={track ? { sessionId: track.sessionId, linkId: track.linkId } : undefined}
        onActivity={onActivity}
      />
      <PosRecentCharges
        orgId={orgId}
        locale={locale}
        merchants={allMerchants}
        initial={recent}
        refreshSignal={signal}
        activeSessionId={activity.sessionId}
        trackLocked={activity.locked}
        onTrack={onTrack}
      />
    </div>
  );
}
