// Minimum detectable effect (PLAN §5): MDE ≈ 2.80 × SD_dev / sqrt(n_heldout_planned), labelled approximate
// (2.80 = z_0.975 + z_0.80 ≈ 1.96 + 0.84: two-sided α = 0.05, 80% power, normal approximation to the paired mean
// difference). SD_dev = sample SD (n − 1) of the dev per-user paired differences. Unavailable when SD = 0 or fewer than
// 30 dev pairs (or no planned held-out users).
import { sampleSd } from './bootstrap.ts';
import { MIN_PAIRS } from './verdict.ts';

export const MDE_FACTOR = 2.8;
export const MDE_LABEL = 'approximate MDE (80% power, two-sided α = 0.05, normal approximation)';

export type MdeResult =
  | { kind: 'value'; value: number; sdDev: number; nDev: number; nPlanned: number; approximate: true; label: string }
  | { kind: 'unavailable'; reason: string };

export function computeMde(devDiffs: readonly number[], nPlanned: number): MdeResult {
  for (const d of devDiffs) if (!Number.isFinite(d)) throw new Error('computeMde: non-finite dev difference');
  if (devDiffs.length < MIN_PAIRS) {
    return { kind: 'unavailable', reason: `MDE unavailable: ${devDiffs.length} dev pairs < ${MIN_PAIRS}` };
  }
  if (!Number.isInteger(nPlanned) || nPlanned < 1) {
    return { kind: 'unavailable', reason: `MDE unavailable: planned held-out n = ${nPlanned}` };
  }
  const first = devDiffs[0];
  if (devDiffs.every((d) => d === first)) {
    return { kind: 'unavailable', reason: 'MDE unavailable: SD of dev paired differences is 0' };
  }
  const sdDev = sampleSd(devDiffs);
  if (!(sdDev > 0)) return { kind: 'unavailable', reason: 'MDE unavailable: SD of dev paired differences is 0' };
  return {
    kind: 'value',
    value: (MDE_FACTOR * sdDev) / Math.sqrt(nPlanned),
    sdDev,
    nDev: devDiffs.length,
    nPlanned,
    approximate: true,
    label: MDE_LABEL,
  };
}

export function formatMde(m: MdeResult, digits = 4): string {
  return m.kind === 'value' ? `≈ ${m.value.toFixed(digits)} (${m.label})` : m.reason;
}
