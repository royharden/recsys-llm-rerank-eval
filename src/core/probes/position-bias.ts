// Position-bias index (PLAN §4): mean over users of Spearman(presentation position, output position) on the
// cand_shuffled variant, with a seeded paired-bootstrap 95% CI (the per-user ρ against 0). Flagged when CI low > 0.1.
// Presentation order is random there, so an unbiased ranker scores ρ ≈ 0 whatever its skill; a ranker that prefers
// what it was shown first scores ρ > 0. Lists shorter than 3 give no ρ; fewer than 2 usable users → unavailable.
import { DEFAULT_RESAMPLES, pairedBootstrap } from '../stats/bootstrap.ts';

export const POSITION_BIAS_FLAG = 0.1;
export const MIN_SPEARMAN_LENGTH = 3;

/** Spearman ρ between presentation positions and output positions of the same items (no ties: both are permutations). */
export function spearmanPositions(presented: readonly number[], output: readonly number[]): number | null {
  const n = presented.length;
  if (n !== output.length) throw new Error('spearmanPositions: lengths differ');
  if (n < MIN_SPEARMAN_LENGTH) return null;
  const outPos = new Map(output.map((id, i): [number, number] => [id, i]));
  if (outPos.size !== n) throw new Error('spearmanPositions: repeated ids');
  let d2 = 0;
  presented.forEach((id, p) => {
    const o = outPos.get(id);
    if (o === undefined) throw new Error(`spearmanPositions: id ${id} missing from the output`);
    d2 += (p - o) * (p - o);
  });
  return 1 - (6 * d2) / (n * (n * n - 1));
}

export type PositionBiasIndex =
  | {
      kind: 'value';
      mean: number;
      ciLow: number;
      ciHigh: number;
      n: number;
      flagged: boolean;
      zeroVariance: boolean;
      resamples: number;
      seed: number;
    }
  | { kind: 'unavailable'; reason: string; n: number };

export function positionBiasIndex(
  pairs: readonly { presented: readonly number[]; output: readonly number[] }[],
  opts: { seed: number; resamples?: number },
): PositionBiasIndex {
  const rhos: number[] = [];
  for (const p of pairs) {
    const r = spearmanPositions(p.presented, p.output);
    if (r !== null) rhos.push(r);
  }
  if (rhos.length < 2) {
    return { kind: 'unavailable', reason: `${rhos.length} user(s) with ≥ ${MIN_SPEARMAN_LENGTH} candidates (need ≥ 2)`, n: rhos.length };
  }
  const resamples = opts.resamples ?? DEFAULT_RESAMPLES;
  const b = pairedBootstrap(rhos, rhos.map(() => 0), { seed: opts.seed, resamples });
  if (!b.ok) return { kind: 'unavailable', reason: b.reason, n: rhos.length };
  const r = b.result;
  return {
    kind: 'value',
    mean: r.meanDiff,
    ciLow: r.ciLow,
    ciHigh: r.ciHigh,
    n: r.n,
    flagged: r.ciLow > POSITION_BIAS_FLAG,
    zeroVariance: r.zeroVariance,
    resamples,
    seed: opts.seed,
  };
}
