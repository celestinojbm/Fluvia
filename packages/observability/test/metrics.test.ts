import { describe, expect, it } from 'vitest';
import { MAX_SERIES_PER_METRIC, MetricsRegistry } from '../src/index.js';

describe('MetricsRegistry (F1-07)', () => {
  it('counters accumulate per label set and render in Prometheus text format', () => {
    const reg = new MetricsRegistry();
    const c = reg.counter('fluvia_test_total', 'Peticiones de prueba', ['method', 'status']);
    c.inc({ method: 'GET', status: '200' });
    c.inc({ method: 'GET', status: '200' });
    c.inc({ method: 'POST', status: '404' }, 3);
    const out = reg.render();
    expect(out).toContain('# HELP fluvia_test_total Peticiones de prueba');
    expect(out).toContain('# TYPE fluvia_test_total counter');
    expect(out).toContain('fluvia_test_total{method="GET",status="200"} 2');
    expect(out).toContain('fluvia_test_total{method="POST",status="404"} 3');
  });

  it('counter rejects negative or non-finite increments', () => {
    const reg = new MetricsRegistry();
    const c = reg.counter('fluvia_neg_total', 'x');
    expect(() => c.inc({}, -1)).toThrow(/>= 0/);
    expect(() => c.inc({}, Number.NaN)).toThrow(/>= 0/);
  });

  it('gauges hold the last value set', () => {
    const reg = new MetricsRegistry();
    const g = reg.gauge('fluvia_drift_accounts', 'Cuentas con drift');
    g.set({}, 4);
    g.set({}, 0);
    expect(reg.render()).toContain('fluvia_drift_accounts 0');
  });

  it('histograms expose cumulative buckets, +Inf, sum and count', () => {
    const reg = new MetricsRegistry();
    const h = reg.histogram('fluvia_dur_seconds', 'Duracion', ['route'], [0.1, 1]);
    h.observe({ route: '/x' }, 0.05);
    h.observe({ route: '/x' }, 0.5);
    h.observe({ route: '/x' }, 5);
    const out = reg.render();
    expect(out).toContain('fluvia_dur_seconds_bucket{route="/x",le="0.1"} 1');
    expect(out).toContain('fluvia_dur_seconds_bucket{route="/x",le="1"} 2');
    expect(out).toContain('fluvia_dur_seconds_bucket{route="/x",le="+Inf"} 3');
    expect(out).toContain('fluvia_dur_seconds_sum{route="/x"} 5.55');
    expect(out).toContain('fluvia_dur_seconds_count{route="/x"} 3');
  });

  it('histogram rejects non-increasing buckets', () => {
    const reg = new MetricsRegistry();
    expect(() => reg.histogram('fluvia_bad_seconds', 'x', [], [1, 1])).toThrow(/increasing/);
    expect(() => reg.histogram('fluvia_empty_seconds', 'x', [], [])).toThrow(/bucket/);
  });

  it('rejects invalid metric names, invalid label names and duplicate registration', () => {
    const reg = new MetricsRegistry();
    expect(() => reg.counter('9bad', 'x')).toThrow(/invalid metric name/);
    expect(() => reg.counter('fluvia_ok_total', 'x', ['bad-label'])).toThrow(/invalid label/);
    expect(() => reg.counter('fluvia_ok_total', 'x', ['__reserved'])).toThrow(/invalid label/);
    reg.counter('fluvia_dup_total', 'x');
    expect(() => reg.gauge('fluvia_dup_total', 'x')).toThrow(/already registered/);
  });

  it('using an undeclared label is a programming error and throws', () => {
    const reg = new MetricsRegistry();
    const c = reg.counter('fluvia_lbl_total', 'x', ['a']);
    expect(() => c.inc({ a: '1', b: '2' })).toThrow(/unknown label/);
  });

  it('escapes label values and help text so exposition stays parseable', () => {
    const reg = new MetricsRegistry();
    const c = reg.counter('fluvia_esc_total', 'linea\ncon "salto"', ['v']);
    c.inc({ v: 'a"b\\c\nd' });
    const out = reg.render();
    expect(out).toContain('# HELP fluvia_esc_total linea\\ncon "salto"');
    expect(out).toContain('fluvia_esc_total{v="a\\"b\\\\c\\nd"} 1');
  });

  it('cardinality guard drops excess series instead of growing unbounded', () => {
    const reg = new MetricsRegistry();
    const c = reg.counter('fluvia_card_total', 'x', ['id']);
    for (let i = 0; i < MAX_SERIES_PER_METRIC + 25; i += 1) {
      c.inc({ id: String(i) });
    }
    const out = reg.render();
    // Las primeras series existen; las excedentes no y quedan contadas.
    expect(out).toContain('fluvia_card_total{id="0"} 1');
    expect(out).not.toContain(`fluvia_card_total{id="${MAX_SERIES_PER_METRIC + 10}"}`);
    expect(out).toContain('fluvia_metrics_dropped_series_total 25');
  });
});
