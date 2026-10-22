'use client';

import { m } from 'framer-motion';
import { useEffect, useState } from 'react';
import { STEPS } from '../content';

function StepNumber({ to, go }: { to: number; go: boolean }) {
  const [n, setN] = useState(to);

  useEffect(() => {
    if (!go) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setN(to);
      return;
    }
    const started = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const progress = Math.min(1, (now - started) / 480);
      setN(Math.round(to * progress));
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    setN(0);
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [go, to]);

  return <span className="step-no">{String(n).padStart(2, '0')}</span>;
}

export function Steps() {
  const [seen, setSeen] = useState(false);
  return (
    <section className="steps" id="como-funciona" aria-labelledby="como-funciona-title">
      <div className="steps-intro">
        <p className="eyebrow">Próximamente</p>
        <h2 id="como-funciona-title">Cómo funciona</h2>
      </div>
      {STEPS.map((step, index) => (
        <m.article
          key={step.n}
          className={step.n === 2 ? 'step step-mint' : 'step'}
          initial={false}
          whileInView={{ y: [24, 0] }}
          viewport={{ once: true, amount: 0.45 }}
          transition={{ duration: 0.48, delay: index * 0.08, ease: [0.22, 1, 0.36, 1] }}
          onViewportEnter={() => setSeen(true)}
        >
          <StepNumber to={step.n} go={seen} />
          <h3>{step.title}</h3>
          <p>{step.body}</p>
        </m.article>
      ))}
    </section>
  );
}
