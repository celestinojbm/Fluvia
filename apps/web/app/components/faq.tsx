'use client';

import { useId, useState } from 'react';
import { FAQ } from '../content';
import { Icon } from './icons';

export function Faq() {
  const base = useId();
  const [open, setOpen] = useState(0);

  return (
    <section className="faq" id="preguntas" aria-labelledby="faq-title">
      <div className="faq-intro">
        <p className="eyebrow">06 · Preguntas</p>
        <h2 id="faq-title">Lo que nos preguntan antes de integrar.</h2>
      </div>
      <div className="faq-list">
        {FAQ.map((item, index) => {
          const panelId = `${base}-p-${index}`;
          const buttonId = `${base}-b-${index}`;
          const isOpen = open === index;
          return (
            <div key={item.q} className={isOpen ? 'faq-item is-open' : 'faq-item'}>
              <h3>
                <button
                  id={buttonId}
                  type="button"
                  aria-expanded={isOpen}
                  aria-controls={panelId}
                  onClick={() => setOpen(isOpen ? -1 : index)}
                >
                  <span>{item.q}</span>
                  <span className={isOpen ? 'faq-icon is-open' : 'faq-icon'} aria-hidden="true">
                    <Icon name={isOpen ? 'minus' : 'plus'} size={16} />
                  </span>
                </button>
              </h3>
              <div className="faq-a" id={panelId} role="region" aria-labelledby={buttonId}>
                <div inert={isOpen ? undefined : true}>
                  <p>{item.a}</p>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
