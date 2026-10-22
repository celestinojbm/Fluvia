'use client';

import { useEffect, useRef } from 'react';
import { m } from 'framer-motion';
import { LEDGER_LINES } from '../content';
import { Button } from './button';
import { Meander } from './meander';
import { NumberTicker } from './number-ticker';

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
          <p className="eyebrow">Asiento nº 000342 · en vivo en sandbox</p>
          <m.article
            className="receipt"
            aria-label="Recibo de ejemplo"
            initial={{ y: -24, rotate: 0 }}
            animate={{ y: 0, rotate: -1.5 }}
            transition={{ type: 'spring', stiffness: 260, damping: 24 }}
          >
            <header className="receipt-top">
              <p className="eyebrow">Importe cobrado</p>
              <p className="chip chip-ok">
                <i />
                Conciliado
              </p>
            </header>
            <p className="receipt-amount">
              Bs. <span className="fl-num">24.100,00</span>
            </p>
            <div className="dots" />
            <table className="ledger">
              <caption className="sr-only">
                Asiento de ejemplo 000342. Datos de ejemplo, sin dinero real. Tres partidas, debe y
                haber en cero, estado conciliado.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Cuenta</th>
                  <th scope="col">Debe</th>
                  <th scope="col">Haber</th>
                </tr>
              </thead>
              <tbody>
                {LEDGER_LINES.map((line, index) => (
                  <tr key={line.account} style={{ animationDelay: `${index * 90}ms` }}>
                    <th scope="row">{line.account}</th>
                    <td className="fl-num">{line.debit}</td>
                    <td className="fl-num">{line.credit}</td>
                  </tr>
                ))}
              </tbody>
              <tbody className="ledger-diff">
                <tr>
                  <th scope="row">Diferencia</th>
                  <td />
                  <td className="fl-num">
                    <NumberTicker from={24100} to={0} />
                  </td>
                </tr>
              </tbody>
            </table>
            <p className="receipt-meta">22.10.2026 · 03:46 · ref FLV-8F2K · datos de ejemplo</p>
          </m.article>
          <p className="caption">
            Sin dinero real: Fluvia está en sandbox hasta superar los controles de producción.
          </p>
        </div>
        <Meander />
      </section>
      <section className="stats" aria-label="Cierre del asiento de ejemplo">
        <p>
          <span className="eyebrow">Diferencia</span>
          <strong className="fl-num">0,00</strong>
        </p>
        <p>
          <span className="eyebrow">Debe y haber</span>
          <strong>2 partidas</strong>
        </p>
        <p>
          <span className="eyebrow">Conciliado</span>
          <strong className="fl-num">100%</strong>
        </p>
      </section>
    </>
  );
}
