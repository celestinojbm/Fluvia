'use client';

import { useEffect, useState, type KeyboardEvent } from 'react';
import { CONNECTORS, SAMPLES, type SampleId } from '../content';
import { Button } from './button';
import { Icon, type IconName } from './icons';

const ORDER: SampleId[] = ['curl', 'node', 'python'];

export function ApiPanel() {
  const [tab, setTab] = useState<SampleId>('curl');
  const [lines, setLines] = useState(SAMPLES.curl.lines.length);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const sample = SAMPLES[tab];

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (window.sessionStorage.getItem('fluvia-code-typed') === '1') return;
    setLines(0);
    let current = 0;
    const timer = window.setInterval(() => {
      current += 1;
      setLines(current);
      if (current >= SAMPLES.curl.lines.length) {
        window.clearInterval(timer);
        window.sessionStorage.setItem('fluvia-code-typed', '1');
      }
    }, 30);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1200);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function copy() {
    setCopyError(false);
    try {
      await navigator.clipboard.writeText(SAMPLES[tab].lines.join('\n'));
      setCopied(true);
    } catch {
      setCopied(false);
      setCopyError(true);
    }
  }

  function onTabsKey(event: KeyboardEvent<HTMLDivElement>) {
    const index = ORDER.indexOf(tab);
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const next =
      event.key === 'ArrowRight'
        ? ORDER[(index + 1) % ORDER.length]!
        : ORDER[(index - 1 + ORDER.length) % ORDER.length]!;
    setTab(next);
    setLines(SAMPLES[next].lines.length);
    document.getElementById(`tab-${next}`)?.focus();
  }

  const shown = tab === 'curl' ? lines : sample.lines.length;

  return (
    <section className="api" id="api" aria-labelledby="api-title">
      <div className="api-intro">
        <p className="eyebrow">04 · Integraciones y API</p>
        <h2 id="api-title">
          Una API.
          <br />
          Todo el libro.
        </h2>
      </div>
      <div className="code-card grain">
        <div className="tabs" role="tablist" aria-label="Ejemplo de API" onKeyDown={onTabsKey}>
          {ORDER.map((id) => (
            <button
              key={id}
              id={`tab-${id}`}
              type="button"
              role="tab"
              aria-selected={tab === id}
              aria-controls={`panel-${id}`}
              tabIndex={tab === id ? 0 : -1}
              className={tab === id ? 'is-on' : ''}
              onClick={() => {
                setTab(id);
                setLines(SAMPLES[id].lines.length);
              }}
            >
              {SAMPLES[id].label}
            </button>
          ))}
        </div>
        <pre id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`} tabIndex={0}>
          <code>
            {sample.lines.map((line, index) => (
              <span
                key={`${tab}-${index}`}
                className={line.startsWith('//') || line.startsWith('#') ? 'c-comment' : undefined}
                style={{ opacity: index < shown ? 1 : 0 }}
              >
                {line.length === 0 ? ' ' : line}
                {'\n'}
              </span>
            ))}
          </code>
        </pre>
        <p className="code-note">Ejemplo ilustrativo · no ejecuta un cobro.</p>
        <Button
          variant="mint"
          onClick={() => void copy()}
          busy={false}
          icon={copied ? <Icon name="check" size={16} /> : <Icon name="copy" size={16} />}
        >
          {copied ? 'Copiado' : 'Copiar'}
        </Button>
        <p className="sr-only" aria-live="polite">
          {copied ? 'Ejemplo copiado' : copyError ? 'No se pudo copiar' : ''}
        </p>
      </div>
      <div className="connectors">
        <p className="eyebrow">Conectores (sandbox)</p>
        <ul>
          {CONNECTORS.map((item) => (
            <li key={item.name}>
              <span className="connectors-name">
                <Icon name={item.icon as IconName} size={20} />
                {item.name}
              </span>
              <span className={`status status-${item.tone}`}>{item.status}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
