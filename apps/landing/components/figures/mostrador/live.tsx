'use client';

import { useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { Plate } from '../../iso/react/draw';
import { asksForStillness, follow, useInView, useLoop, useReadout } from '../../iso/react/live';
import { MostradorArt } from './art';
import { END_SCREEN, frameOf, HOME_SCREEN, REST_FRAME, WIDTH } from './geometry';
import {
  END,
  HOME,
  readoutOf,
  tourTarget,
  travelFromScreen,
  type Station,
} from './model';

const WORDS: Record<Station, string> = {
  tray: 'en la bandeja',
  moving: 'en camino',
  till: 'en el cajón',
};

const KEYS = [
  { mark: 'lit' as const, label: 'La ficha del pago' },
  { mark: 'raised' as const, label: 'El carro sobre los rieles' },
  { mark: 'edge' as const, label: 'El muelle que la devuelve a la bandeja' },
];

const CAPTION =
  'La ficha sale de la bandeja de quien paga. El carro la lleva por dos rieles hasta el cajón del comercio, y el muelle la devuelve si la sueltas antes de llegar. El cajón de delante está cerrado: es el crédito, y no alimenta la bandeja. El crédito no es saldo propio.';

export function MostradorLive() {
  const { anchor, say } = useReadout<HTMLDivElement>();
  const root = useRef<HTMLDivElement>(null);
  const inView = useInView(root);
  const carriage = useRef<SVGGElement>(null);
  const needle = useRef<SVGPathElement>(null);
  const coils = [
    useRef<SVGPathElement>(null),
    useRef<SVGPathElement>(null),
    useRef<SVGPathElement>(null),
    useRef<SVGPathElement>(null),
  ];
  const spoken = useRef<HTMLSpanElement>(null);
  const range = useRef<HTMLInputElement>(null);
  const travel = useRef(HOME);
  const target = useRef(HOME);
  const latch = useRef(false);
  const dragging = useRef(false);
  const clock = useRef(0);
  const idleAt = useRef(0);
  const word = useRef(WORDS.tray);

  const paint = (x: number) => {
    const frame = frameOf(x);
    carriage.current?.setAttribute('transform', frame.carriage);
    needle.current?.setAttribute('d', frame.needle);
    frame.coils.forEach((d, index) => coils[index]?.current?.setAttribute('d', d));
    const next = readoutOf(x, latch.current);
    say(next);
    if (spoken.current && spoken.current.textContent !== next) spoken.current.textContent = next;
    word.current = next;
    const slider = range.current;
    if (slider && document.activeElement !== slider) {
      slider.value = String(x);
      slider.setAttribute('aria-valuetext', next);
    }
  };

  const pauseTour = () => {
    idleAt.current = performance.now();
  };

  useLoop((dt, calm) => {
    if (calm || asksForStillness()) {
      travel.current = HOME;
      target.current = HOME;
      latch.current = false;
      paint(HOME);
      return false;
    }
    const idle = idleAt.current === 0 ? Number.POSITIVE_INFINITY : (performance.now() - idleAt.current) / 1000;
    if (!dragging.current && idle > 4.5) {
      clock.current += dt;
      const tour = tourTarget(clock.current);
      target.current = tour.x;
      latch.current = tour.latched;
    }
    travel.current = follow(travel.current, target.current, dt, 0.22, calm);
    if (!latch.current && Math.abs(travel.current - HOME) < 0.4) travel.current = HOME;
    paint(travel.current);
    return true;
  }, inView);

  const seek = (x: number, latched: boolean) => {
    pauseTour();
    clock.current = 0;
    target.current = x;
    latch.current = latched;
  };

  const fromPointer = (event: ReactPointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    const screenX = ((event.clientX - rect.left) / rect.width) * WIDTH;
    const x = travelFromScreen(screenX, HOME_SCREEN, END_SCREEN);
    seek(x, false);
  };

  return (
    <div ref={root} className="iso" data-theme="light">
      <Plate
        fig="Fig 1"
        title="Del mostrador al cajón"
        hint="Arrastra · flechas"
        readout={WORDS.tray}
        keys={KEYS}
        caption={CAPTION}
      >
        <div
          ref={anchor}
          tabIndex={0}
          role="group"
          aria-label="Figura interactiva del pago"
          className="outline-none"
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft' && event.key !== 'Home' && event.key !== 'End') {
              return;
            }
            event.preventDefault();
            if (event.key === 'Home') seek(HOME, false);
            else if (event.key === 'End') seek(END, true);
            else {
              const step = event.key === 'ArrowRight' ? 16 : -16;
              const next = Math.min(END, Math.max(HOME, target.current + step));
              seek(next, next >= END - 0.8);
            }
          }}
        >
          <span ref={spoken} className="sr-only" aria-live="polite">
            {WORDS.tray}
          </span>
          <MostradorArt
            frame={REST_FRAME}
            refs={{
              carriage,
              needle,
              coils,
            }}
            svgProps={{
              className: 'touch-pan-y cursor-grab active:cursor-grabbing',
              onPointerDown: (event) => {
                dragging.current = true;
                event.currentTarget.setPointerCapture(event.pointerId);
                fromPointer(event);
              },
              onPointerMove: (event) => {
                if (!dragging.current) return;
                fromPointer(event);
              },
              onPointerUp: () => {
                dragging.current = false;
                const done = target.current >= END - 6;
                seek(done ? END : HOME, done);
              },
              onPointerCancel: () => {
                dragging.current = false;
                seek(HOME, false);
              },
            }}
          />
        </div>
      </Plate>
      <label className="mt-3 grid gap-1 text-xs font-extrabold tracking-[0.08em] text-[var(--fl-ink-2)] uppercase">
        Recorrido de la ficha
        <input
          ref={range}
          className="h-11 w-full accent-[var(--fl-black)]"
          type="range"
          min={HOME}
          max={END}
          step={0.5}
          defaultValue={HOME}
          aria-valuetext={WORDS.tray}
          onPointerDown={() => {
            dragging.current = true;
          }}
          onInput={(event) => {
            const x = Number(event.currentTarget.value);
            seek(x, x >= END - 0.8);
          }}
          onPointerUp={() => {
            dragging.current = false;
            pauseTour();
          }}
          onKeyUp={() => {
            dragging.current = false;
            pauseTour();
          }}
          onBlur={() => {
            dragging.current = false;
          }}
        />
      </label>
    </div>
  );
}
