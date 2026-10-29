import { describe, expect, it } from 'vitest';
import {
  bootstrapMeans,
  DEFAULT_RESAMPLES,
  pairedBootstrap,
  pairedBootstrapAll,
  percentileSorted,
  sampleSd,
  type BootstrapOutcome,
  type PairedBootstrap,
} from '../../src/core/stats/bootstrap.ts';
import { mulberry32 } from '../../src/core/stats/prng.ts';

const ok = (o: BootstrapOutcome): PairedBootstrap => {
  if (!o.ok) throw new Error(`expected ok bootstrap, got: ${o.reason}`);
  return o.result;
};

function noisy(n: number, seed: number): number[] {
  const rng = mulberry32(seed);
  return Array.from({ length: n }, () => (rng() < 0.3 ? 1 / Math.log2(2 + Math.floor(rng() * 9)) : 0));
}

describe('paired bootstrap', () => {
  it('defaults to 10,000 resamples', () => {
    expect(DEFAULT_RESAMPLES).toBe(10_000);
    const r = ok(pairedBootstrap(noisy(40, 1), noisy(40, 2), { seed: 5 }));
    expect(r.resamples).toBe(10_000);
    expect(bootstrapMeans([0, 1], 10_000, 5)).toHaveLength(10_000);
  });

  it('is reproducible for a seed', () => {
    const a = noisy(60, 1);
    const b = noisy(60, 2);
    const r1 = ok(pairedBootstrap(a, b, { seed: 38 }));
    const r2 = ok(pairedBootstrap(a, b, { seed: 38 }));
    expect(r2).toEqual(r1);
    const r3 = ok(pairedBootstrap(a, b, { seed: 39 }));
    expect([r3.ciLow, r3.ciHigh]).not.toEqual([r1.ciLow, r1.ciHigh]);
    expect(r3.meanDiff).toBe(r1.meanDiff); // the observed mean does not depend on the seed
  });

  it('is paired: only per-user differences matter', () => {
    const a = noisy(50, 3);
    const b = noisy(50, 4);
    const diffs = a.map((x, i) => x - b[i]);
    const zeros = diffs.map(() => 0);
    const r = ok(pairedBootstrap(a, b, { seed: 11, resamples: 2000 }));
    const d = ok(pairedBootstrap(diffs, zeros, { seed: 11, resamples: 2000 }));
    expect([d.ciLow, d.ciHigh, d.meanDiff]).toEqual([r.ciLow, r.ciHigh, r.meanDiff]);
  });

  it('uses the same resampled indices across comparisons (shift by a constant shifts the CI by it)', () => {
    const control = Array.from({ length: 45 }, () => 0);
    const rng = mulberry32(9);
    const arm1 = control.map(() => (rng() < 0.5 ? 1 : 0));
    const arm2 = arm1.map((x) => x + 1);
    const all = pairedBootstrapAll(control, { arm1, arm2 }, { seed: 21, resamples: 3000 });
    const r1 = ok(all.arm1);
    const r2 = ok(all.arm2);
    expect(r2.ciLow).toBeCloseTo(r1.ciLow + 1, 12);
    expect(r2.ciHigh).toBeCloseTo(r1.ciHigh + 1, 12);
  });

  it('all-zero differences → [0, 0], zero variance', () => {
    const z = Array.from({ length: 40 }, () => 0.25);
    const r = ok(pairedBootstrap(z, z, { seed: 1 }));
    expect([r.ciLow, r.ciHigh, r.meanDiff]).toEqual([0, 0, 0]);
    expect(r.zeroVariance).toBe(true);
    expect(r.sdDiff).toBe(0);
  });

  it('constant +1 differences → [1, 1]', () => {
    const a = Array.from({ length: 40 }, () => 1);
    const b = Array.from({ length: 40 }, () => 0);
    const r = ok(pairedBootstrap(a, b, { seed: 1 }));
    expect([r.ciLow, r.ciHigh, r.meanDiff]).toEqual([1, 1, 1]);
    expect(r.zeroVariance).toBe(true);
  });

  it('constant non-dyadic difference is returned exactly (no summation drift)', () => {
    const a = Array.from({ length: 33 }, () => 0.1);
    const b = Array.from({ length: 33 }, () => 0);
    const r = ok(pairedBootstrap(a, b, { seed: 1 }));
    expect([r.ciLow, r.ciHigh]).toEqual([0.1, 0.1]);
  });

  it('CI brackets the mean for well-behaved data and low ≤ high', () => {
    const r = ok(pairedBootstrap(noisy(200, 7), noisy(200, 8), { seed: 3 }));
    expect(r.ciLow).toBeLessThanOrEqual(r.ciHigh);
    expect(r.ciLow).toBeLessThanOrEqual(r.meanDiff);
    expect(r.ciHigh).toBeGreaterThanOrEqual(r.meanDiff);
  });

  it('no pairs → not ok; unpaired or non-finite inputs throw', () => {
    expect(pairedBootstrap([], [], { seed: 1 })).toEqual({ ok: false, n: 0, reason: 'no paired users' });
    expect(() => pairedBootstrap([1, 2], [1], { seed: 1 })).toThrow(/unpaired/);
    expect(() => pairedBootstrap([Number.NaN], [0], { seed: 1 })).toThrow(/non-finite/);
    expect(() => pairedBootstrap([1], [0], { seed: 1.5 })).toThrow(/seed/);
  });
});

describe('helpers', () => {
  it('percentile with linear interpolation', () => {
    const xs = Float64Array.from(range(0, 100));
    expect(percentileSorted(xs, 0.025)).toBeCloseTo(2.5, 12);
    expect(percentileSorted(xs, 0.975)).toBeCloseTo(97.5, 12);
    expect(percentileSorted(xs, 0)).toBe(0);
    expect(percentileSorted(xs, 1)).toBe(100);
    expect(percentileSorted([4], 0.5)).toBe(4);
  });

  it('sample SD uses n − 1', () => {
    expect(sampleSd([1, 2, 3, 4])).toBeCloseTo(Math.sqrt(5 / 3), 12);
    expect(sampleSd([5])).toBe(0);
  });
});

function range(a: number, b: number): number[] {
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}
