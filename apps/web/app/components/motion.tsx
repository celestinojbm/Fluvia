'use client';

import { LazyMotion, MotionConfig, domAnimation } from 'framer-motion';
import type { ReactNode } from 'react';

/**
 * `domAnimation` (sin layout/drag) mantiene el extra de movimiento cerca de
 * 18 KB gz. El titular y el recibo entran con CSS para que el LCP no dependa
 * de hidratar este runtime; el estado sin JS ya es el final.
 */
export function MotionRoot({ children }: { children: ReactNode }) {
  return (
    <MotionConfig reducedMotion="user">
      <LazyMotion features={domAnimation} strict>
        {children}
      </LazyMotion>
    </MotionConfig>
  );
}
