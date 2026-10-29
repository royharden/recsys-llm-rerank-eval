// Paired bootstrap (PLAN §5): resample USERS with replacement (the same resampled index vector is applied to both arms
// of a comparison, i.e. to the per-user difference), 10,000 resamples by default, seeded mulberry32, percentile 95% CI
// (2.5th / 97.5th percentiles, linear interpolation between order statistics) of the mean per-user difference.
// The index stream depends only on (seed, n), so every comparison run with the same seed over the same users draws the
// identical resampled index sequence (e.g. every arm vs itemknn).
import { mulberry32 } from './prng.ts';

export const DEFAULT_RESAMPLES = 10_000;
export const CI_LOW_P = 0.025;
export const CI_HIGH_P = 0.975;

export interface BootstrapOptions {
  /** 32-bit seed (e.g. deriveSeed(runSeed, 'bootstrap', 'ndcg10')). */
  seed: number;
  resamples?: number;
}

export interface PairedBootstrap {
  n: number;
  /** Observed mean of (treatment − control). */
  meanDiff: number;
  ciLow: number;
  ciHigh: number;
  /** Sample SD (n − 1) of the per-user differences; 0 when n < 2. */
  sdDiff: number;
  /** All per-user differences are identical: the bootstrap distribution is a point mass at meanDiff. */
  zeroVariance: boolean;
  resamples: number;
  seed: number;
}

export type BootstrapOutcome = { ok: true; result: PairedBootstrap } | { ok: false; n: number; reason: string };

/** Per-user differences treatment − control. Throws on length mismatch or non-finite values (programming errors). */
export function pairedDiffs(treatment: readonly number[], control: readonly number[]): number[] {
  if (treatment.length !== control.length) {
    throw new Error(`pairedBootstrap: unpaired inputs (${treatment.length} vs ${control.length})`);
  }
  return treatment.map((t, i) => {
    const d = t - control[i];
    if (!Number.isFinite(d)) throw new Error(`pairedBootstrap: non-finite value at index ${i}`);
    return d;
  });
}

function meanOf(xs: readonly number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

export function sampleSd(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = meanOf(xs);
  let ss = 0;
  for (const x of xs) ss += (x - m) * (x - m);
  return Math.sqrt(ss / (xs.length - 1));
}

/** Linear-interpolation percentile of an ascending array (R type 7). */
export function percentileSorted(sorted: ArrayLike<number>, p: number): number {
  const n = sorted.length;
  if (n === 0) throw new Error('percentileSorted: empty');
  if (!(p >= 0 && p <= 1)) throw new Error(`percentileSorted: p=${p} out of [0, 1]`);
  const h = (n - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.min(n - 1, lo + 1);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

/** Resampled means of `diffs` (one per resample), in draw order. Index j of resample r is floor(rng()·n). */
export function bootstrapMeans(diffs: readonly number[], resamples: number, seed: number): Float64Array {
  const n = diffs.length;
  if (n === 0) throw new Error('bootstrapMeans: no pairs');
  if (!Number.isInteger(resamples) || resamples < 1) throw new Error(`bootstrapMeans: bad resamples ${resamples}`);
  const rng = mulberry32(seed);
  const out = new Float64Array(resamples);
  for (let r = 0; r < resamples; r++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += diffs[Math.floor(rng() * n)];
    out[r] = s / n;
  }
  return out;
}

export function pairedBootstrap(
  treatment: readonly number[],
  control: readonly number[],
  opts: BootstrapOptions,
): BootstrapOutcome {
  const diffs = pairedDiffs(treatment, control);
  const n = diffs.length;
  const resamples = opts.resamples ?? DEFAULT_RESAMPLES;
  if (!Number.isInteger(opts.seed)) throw new Error(`pairedBootstrap: seed must be an integer, got ${opts.seed}`);
  if (n === 0) return { ok: false, n, reason: 'no paired users' };

  const first = diffs[0];
  const zeroVariance = diffs.every((d) => d === first);
  if (zeroVariance) {
    // Point mass: every resample mean is mathematically `first`; return it exactly (no summation rounding).
    return {
      ok: true,
      result: { n, meanDiff: first, ciLow: first, ciHigh: first, sdDiff: 0, zeroVariance, resamples, seed: opts.seed },
    };
  }
  const means = bootstrapMeans(diffs, resamples, opts.seed).sort();
  return {
    ok: true,
    result: {
      n,
      meanDiff: meanOf(diffs),
      ciLow: percentileSorted(means, CI_LOW_P),
      ciHigh: percentileSorted(means, CI_HIGH_P),
      sdDiff: sampleSd(diffs),
      zeroVariance,
      resamples,
      seed: opts.seed,
    },
  };
}

/** Every arm vs one control with the same seed (identical resampled indices across comparisons of equal n). */
export function pairedBootstrapAll(
  control: readonly number[],
  arms: Readonly<Record<string, readonly number[]>>,
  opts: BootstrapOptions,
): Record<string, BootstrapOutcome> {
  const out: Record<string, BootstrapOutcome> = {};
  for (const name of Object.keys(arms).sort()) out[name] = pairedBootstrap(arms[name], control, opts);
  return out;
}
