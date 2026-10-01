import { describe, expect, it } from 'vitest';
import { camel, snake } from '../src/routes/wire.js';

describe('serialización pública del programa', () => {
  it('snake_case, bigint como string y códigos de moneda intactos; camel lo invierte', () => {
    const v = {
      maxMultiplierBps: 40000,
      currencies: { VES: { minCollateral: 5n, manualReviewAbove: '8' } },
      when: undefined,
    };
    const s = snake(v) as Record<string, unknown>;
    expect(s).toEqual({
      max_multiplier_bps: 40000,
      currencies: { VES: { min_collateral: '5', manual_review_above: '8' } },
    });
    expect(camel(s)).toEqual({
      maxMultiplierBps: 40000,
      currencies: { VES: { minCollateral: '5', manualReviewAbove: '8' } },
    });
  });
});
