// Verdict (PLAN §5), primary comparison only:
//   n < 30 pairs → 'insufficient data'; else 'better' if CI low > 0, 'worse' if CI high < 0, else 'no detectable difference'.
// Zero variance is NOT insufficient: all-zero differences → [0, 0] → no detectable difference; a constant c > 0 → better;
// both carry a "degenerate bootstrap" note. 30 ≤ n < 150 carries a small-n warning. A CI spanning zero is never
// called equivalence.
import type { BootstrapOutcome } from './bootstrap.ts';

export const MIN_PAIRS = 30;
/** Below the planned held-out minimum (split MIN_HELDOUT = 150) the CI is flagged as wide. */
export const SMALL_N_WARNING_BELOW = 150;

export const VERDICTS = ['better', 'worse', 'no detectable difference', 'insufficient data'] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface VerdictResult {
  verdict: Verdict;
  n: number;
  meanDiff: number | null;
  ci: [number, number] | null;
  notes: string[];
  warnings: string[];
}

export function verdictFrom(outcome: BootstrapOutcome): VerdictResult {
  if (!outcome.ok) {
    return {
      verdict: 'insufficient data',
      n: outcome.n,
      meanDiff: null,
      ci: null,
      notes: [`no bootstrap: ${outcome.reason}`],
      warnings: [],
    };
  }
  const r = outcome.result;
  const ci: [number, number] = [r.ciLow, r.ciHigh];
  const notes: string[] = [];
  const warnings: string[] = [];
  if (r.zeroVariance) {
    notes.push(`degenerate bootstrap: every paired difference equals ${r.meanDiff}, so the CI collapses to [${r.ciLow}, ${r.ciHigh}]`);
  }
  if (r.n < MIN_PAIRS) {
    return {
      verdict: 'insufficient data',
      n: r.n,
      meanDiff: r.meanDiff,
      ci,
      notes: [...notes, `n = ${r.n} paired users < ${MIN_PAIRS}: no verdict`],
      warnings,
    };
  }
  if (r.n < SMALL_N_WARNING_BELOW) {
    warnings.push(`small n: ${r.n} paired users (< ${SMALL_N_WARNING_BELOW} planned); the CI is wide and a null result is weak evidence`);
  }
  let verdict: Verdict;
  if (r.ciLow > 0) verdict = 'better';
  else if (r.ciHigh < 0) verdict = 'worse';
  else {
    verdict = 'no detectable difference';
    notes.push('the 95% CI includes 0; this is not evidence of equivalence');
  }
  return { verdict, n: r.n, meanDiff: r.meanDiff, ci, notes, warnings };
}
