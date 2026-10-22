'use client';

import { useEffect, useRef } from 'react';
import { m } from 'framer-motion';
import { RECEIPT_LINES } from '../content';
import { Button } from './button';
import { Meander } from './meander';

export function Hero() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
    if (reduced || window.innerWidth < 768 || memory === undefined || memory < 4) return;
    let cancel = () => {};
    let dropped = false;
    void import('./particles').then((mod) => {
      if (dropped) return;
      cancel = mod.startParticles(canvas);
    });
    return () => {
      dropped = true;
      cancel();
    };
  }, []);

  return (
    <>
      <section className="hero" aria-labelledby="hero-title">
        <div className="hero-copy">
          <p className="pill-soon">Próximamente</p>
          <h1 id="hero-title" className="hero-title-bnpl">
            <span className="hero-line-1">Tú cobras completo.</span>{' '}
            <span className="hero-line-2">Tu cliente paga en cuotas.</span>
          </h1>
          <p className="lede">
            Recibes el total de tu venta, menos la comisión. No es un préstamo para tu negocio.
          </p>
          <div className="hero-actions">
            <Button variant="primary" disabled aria-describedby="cta-note">
              Avísame cuando esté lista
            </Button>
            <a className="hero-link" href="#como-funciona">
              Cómo funciona
            </a>
          </div>
          <p id="cta-note" className="hero-note">
            Aún no recogemos datos: Fluvia está en pruebas.
          </p>
        </div>
        <div className="hero-stage grain">
          <canvas ref={canvasRef} className="particles" aria-hidden="true" />
          <p className="eyebrow">Recibo ilustrativo · sandbox</p>
          <m.article
            className="receipt"
            data-example=""
            aria-label="Recibo de ejemplo"
            initial={{ y: -24, rotate: 0 }}
            animate={{ y: 0, rotate: -1.5 }}
            transition={{ type: 'spring', stiffness: 260, damping: 24 }}
          >
            <header className="receipt-top">
              <p className="eyebrow">Tu venta en cuotas</p>
              <p className="chip chip-ok">
                <i />
                Liquidada
              </p>
            </header>
            <div className="dots" />
            <ul className="receipt-bars" aria-label="Total de la venta menos comisión al comercio">
              {RECEIPT_LINES.map((line) => (
                <li key={line.label} className={`receipt-bar receipt-bar-${line.bar}`}>
                  <span className="receipt-bar-label">
                    {line.sign ? <span aria-hidden="true">{line.sign} </span> : null}
                    {line.label}
                  </span>
                  <span className="receipt-bar-track" aria-hidden="true">
                    <span className="receipt-bar-fill" />
                  </span>
                </li>
              ))}
            </ul>
            <p className="receipt-meta">Ilustrativo · datos de ejemplo · sin importes</p>
          </m.article>
          <p className="caption">
            Sin dinero real: Fluvia está en sandbox hasta superar los controles de producción.
          </p>
        </div>
        <Meander />
      </section>
      <section className="stats" data-example="" aria-label="Resumen del recibo de ejemplo">
        <p className="sr-only">Datos de ejemplo</p>
        <p>
          <span className="eyebrow">Tú recibes</span>
          <strong>Total menos comisión</strong>
        </p>
        <p>
          <span className="eyebrow">Tu cliente</span>
          <strong>Paga en cuotas</strong>
        </p>
        <p>
          <span className="eyebrow">Liquidación</span>
          <strong>Una sola</strong>
        </p>
      </section>
    </>
  );
}
