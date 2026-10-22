'use client';

import { useEffect, useRef, useState } from 'react';
import { formatBolivares } from '../format';

/** De `from` a `to` en 600 ms. El primer pintado ya es el valor final (sin JS, CLS 0). */
export function NumberTicker({
  from,
  to,
  duration = 600,
}: {
  from: number;
  to: number;
  duration?: number;
}) {
  const [value, setValue] = useState(to);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const node = ref.current;
    if (!node) return;
    let frame = 0;
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      const t0 = performance.now();
      const tick = (now: number) => {
        const p = Math.min(1, (now - t0) / duration);
        const eased = 1 - (1 - p) ** 3;
        setValue(from + (to - from) * eased);
        if (p < 1) frame = requestAnimationFrame(tick);
      };
      setValue(from);
      frame = requestAnimationFrame(tick);
    };
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) start();
      },
      { threshold: 0.4 }
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [from, to, duration]);

  return (
    <span ref={ref} className="fl-num">
      {formatBolivares(value)}
    </span>
  );
}
