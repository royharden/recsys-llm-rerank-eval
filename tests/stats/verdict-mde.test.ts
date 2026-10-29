import { describe, expect, it } from 'vitest';
import { pairedBootstrap, type BootstrapOutcome } from '../../src/core/stats/bootstrap.ts';
import { computeMde, formatMde, MDE_FACTOR } from '../../src/core/stats/mde.ts';
import { MIN_PAIRS, verdictFrom } from '../../src/core/stats/verdict.ts';

function outcome(n: number, ciLow: number, ciHigh: number, zeroVariance = false): BootstrapOutcome {
  return {
    ok: true,
    result: { n, meanDiff: (ciLow + ciHigh) / 2, ciLow, ciHigh, sdDiff: zeroVariance ? 0 : 0.1, zeroVariance, resamples: 10_000, seed: 1 },
  };
}

const constant = (n: number, c: number) => Array.from({ length: n }, () => c);

describe('verdict mapping', () => {
  it('CI low > 0 → better; CI high < 0 → worse; spanning 0 → no detectable difference', () => {
    expect(verdictFrom(outcome(200, 0.01, 0.05)).verdict).toBe('better');
    expect(verdictFrom(outcome(200, -0.05, -0.01)).verdict).toBe('worse');
    const ndd = verdictFrom(outcome(200, -0.02, 0.03));
    expect(ndd.verdict).toBe('no detectable difference');
    expect(ndd.notes.join(' ')).toMatch(/not evidence of equivalence/);
  });

  it('a CI touching 0 is not better/worse', () => {
    expect(verdictFrom(outcome(200, 0, 0.05)).verdict).toBe('no detectable difference');
    expect(verdictFrom(outcome(200, -0.05, 0)).verdict).toBe('no detectable difference');
  });

  it('n < 30 → insufficient data even with a clear CI; n = 30 gets a verdict', () => {
    expect(MIN_PAIRS).toBe(30);
    expect(verdictFrom(outcome(29, 0.2, 0.4)).verdict).toBe('insufficient data');
    expect(verdictFrom(outcome(30, 0.2, 0.4)).verdict).toBe('better');
  });

  it('no bootstrap (no pairs) → insufficient data', () => {
    const v = verdictFrom(pairedBootstrap([], [], { seed: 1 }));
    expect(v.verdict).toBe('insufficient data');
    expect(v.ci).toBeNull();
  });

  it('small-n warning for 30 ≤ n < 150 only', () => {
    expect(verdictFrom(outcome(50, 0.1, 0.2)).warnings).toHaveLength(1);
    expect(verdictFrom(outcome(150, 0.1, 0.2)).warnings).toHaveLength(0);
  });

  it('all-zero differences → [0, 0] → no detectable difference with a degenerate-bootstrap note (not insufficient)', () => {
    const v = verdictFrom(pairedBootstrap(constant(40, 0.5), constant(40, 0.5), { seed: 1 }));
    expect(v.verdict).toBe('no detectable difference');
    expect(v.ci).toEqual([0, 0]);
    expect(v.notes.join(' ')).toMatch(/degenerate bootstrap/);
  });

  it('constant +1 differences → [1, 1] → better with a degenerate-bootstrap note', () => {
    const v = verdictFrom(pairedBootstrap(constant(40, 1), constant(40, 0), { seed: 1 }));
    expect(v.verdict).toBe('better');
    expect(v.ci).toEqual([1, 1]);
    expect(v.notes.join(' ')).toMatch(/degenerate bootstrap/);
  });

  it('constant −1 differences → worse; constant +1 with n < 30 → insufficient', () => {
    expect(verdictFrom(pairedBootstrap(constant(40, 0), constant(40, 1), { seed: 1 })).verdict).toBe('worse');
    expect(verdictFrom(pairedBootstrap(constant(29, 1), constant(29, 0), { seed: 1 })).verdict).toBe('insufficient data');
  });
});

describe('MDE ≈ 2.80 · SD_dev / sqrt(n_planned)', () => {
  it('formula on hand-computable dev differences', () => {
    const dev = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? 0 : 1)); // 15 zeros, 15 ones
    const sd = Math.sqrt((30 * 0.25) / 29);
    const m = computeMde(dev, 150);
    expect(m.kind).toBe('value');
    if (m.kind !== 'value') return;
    expect(m.sdDev).toBeCloseTo(sd, 12);
    expect(m.value).toBeCloseTo((MDE_FACTOR * sd) / Math.sqrt(150), 12);
    expect(m.approximate).toBe(true);
    expect(m.nDev).toBe(30);
    expect(formatMde(m)).toMatch(/approximate/);
  });

  it('unavailable: < 30 dev pairs, SD = 0, bad planned n', () => {
    const dev29 = Array.from({ length: 29 }, (_, i) => i % 2);
    expect(computeMde(dev29, 150)).toEqual({ kind: 'unavailable', reason: 'MDE unavailable: 29 dev pairs < 30' });
    expect(computeMde(constant(40, 0.2), 150)).toEqual({
      kind: 'unavailable',
      reason: 'MDE unavailable: SD of dev paired differences is 0',
    });
    expect(computeMde(Array.from({ length: 40 }, (_, i) => i % 2), 0).kind).toBe('unavailable');
    expect(formatMde(computeMde([], 150))).toMatch(/^MDE unavailable/);
  });

  it('non-finite dev differences throw', () => {
    expect(() => computeMde([...constant(30, 0), Number.POSITIVE_INFINITY], 150)).toThrow();
  });
});
