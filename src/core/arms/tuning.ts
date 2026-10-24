// Dev-only tuning (PLAN §3), in this order:
//   1. neighbourhood k ∈ {20, 50, 100, 'all'} on dev itemknn NDCG@10 — ties → smaller k;
//   2. list size K ∈ {20, 30}: K = 30 only if dev ceiling(30) − ceiling(20) ≥ 0.03 AND fitsCap(30); if fitsCap(20) is
//      false, live start is refused (no silent K reduction or sampling). The cap predicate is injected (budget is M3);
//   3. tuned-rerank weights on the 0.25 convex grid on dev NDCG@10 — ties → earlier grid entry (larger kNN weight first,
//      i.e. the most baseline-like weighting wins a tie).
// Arms never see targets: the caller injects a TargetJudge (metrics/ranking.ts judgeFromScorer builds one from the Scorer).
import type { Item } from '../data/types.ts';
import type { UserContext } from '../split/context.ts';
import { buildUserContext, type ListK } from './candidates.ts';
import { KNN_K_GRID, knnRanking, type KnnK } from './itemknn.ts';
import type { TrainingData } from './train.ts';
import { orderByWeights, tunedFeatures, weightGrid, type TunedWeights } from './tuned-rerank.ts';

/** Means closer than this are treated as an exact tie (absorbs float summation noise only). */
export const TIE_EPS = 1e-12;
/** Minimum dev ceiling gain (absolute share) for K = 30, as hundredths so the comparison is exact in integers. */
export const K30_MIN_GAIN_HUNDREDTHS = 3;

/** Target-aware scoring supplied by metrics/; tuning code never touches the Scorer itself. */
export interface TargetJudge {
  /** 1-based rank of the user's target in `order`, or null when absent. */
  rankOf(userKey: string, order: readonly number[]): number | null;
  /** NDCG@10 of the user's target in `order` (0 when absent or below 10). */
  ndcgAt10(userKey: string, order: readonly number[]): number;
}

export interface DevUser {
  userKey: string;
  /** Pre-T history item ids, oldest first. */
  history: readonly number[];
}

function kSize(k: KnnK): number {
  return k === 'all' ? Number.POSITIVE_INFINITY : k;
}

function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

// ---------------------------------------------------------------- 1. neighbourhood k

export interface KTrial {
  k: KnnK;
  meanNdcg10: number;
  n: number;
}

export interface KTuning {
  k: KnnK;
  /** One trial per grid value, in ascending k order. */
  trials: KTrial[];
  /** True when there were no dev users: every trial is 0 and the smallest k was chosen by the tie rule. */
  noDevUsers: boolean;
}

export function tuneNeighbourhood(
  train: TrainingData,
  devUsers: readonly DevUser[],
  judge: TargetJudge,
  grid: readonly KnnK[] = KNN_K_GRID,
): KTuning {
  if (grid.length === 0) throw new Error('tuneNeighbourhood: empty grid');
  const ordered = [...grid].sort((a, b) => kSize(a) - kSize(b));
  const trials: KTrial[] = ordered.map((k) => {
    const scores = devUsers.map((u) => judge.ndcgAt10(u.userKey, knnRanking(train, u.history, k, 10).ids));
    return { k, meanNdcg10: mean(scores), n: devUsers.length };
  });
  let best = trials[0];
  for (const t of trials.slice(1)) if (t.meanNdcg10 > best.meanNdcg10 + TIE_EPS) best = t;
  return { k: best.k, trials, noDevUsers: devUsers.length === 0 };
}

// ---------------------------------------------------------------- 2. list size K

/** Is the K-candidate worst-case bound total within the run cap? Injected by the caller (mock: always true). */
export type FitsCap = (K: ListK) => boolean;

export interface DevCeilings {
  n: number;
  /** Dev users whose target is in the kNN top-min(20, pool). */
  hits20: number;
  /** Dev users whose target is in the kNN top-min(30, pool). */
  hits30: number;
}

export type KDecision =
  | { ok: true; K: ListK; ceilings: DevCeilings; reason: string }
  | { ok: false; K: null; ceilings: DevCeilings; reason: string };

export function devCeilings(train: TrainingData, devUsers: readonly DevUser[], judge: TargetJudge, k: KnnK): DevCeilings {
  let hits20 = 0;
  let hits30 = 0;
  for (const u of devUsers) {
    const r = judge.rankOf(u.userKey, knnRanking(train, u.history, k, 30).ids);
    if (r !== null && r <= 30) hits30++;
    if (r !== null && r <= 20) hits20++;
  }
  return { n: devUsers.length, hits20, hits30 };
}

/** Pure K rule on dev counts. Gain test in integers: (hits30 − hits20)·100 ≥ 3·n ⇔ ceiling(30) − ceiling(20) ≥ 0.03. */
export function decideListSize(c: DevCeilings, fitsCap: FitsCap): KDecision {
  if (!fitsCap(20)) {
    return {
      ok: false,
      K: null,
      ceilings: c,
      reason: 'live start refused: the K=20 worst-case bound does not fit the cap (no silent K reduction or sampling)',
    };
  }
  if (c.n === 0) return { ok: true, K: 20, ceilings: c, reason: 'no dev users: K=30 cannot be justified, K=20' };
  const gainOk = (c.hits30 - c.hits20) * 100 >= K30_MIN_GAIN_HUNDREDTHS * c.n;
  if (!gainOk) return { ok: true, K: 20, ceilings: c, reason: 'dev ceiling(30) − ceiling(20) < 0.03, K=20' };
  if (!fitsCap(30)) {
    return { ok: true, K: 20, ceilings: c, reason: 'dev ceiling gain ≥ 0.03 but the K=30 bound total does not fit the cap, K=20' };
  }
  return { ok: true, K: 30, ceilings: c, reason: 'dev ceiling(30) − ceiling(20) ≥ 0.03 and the K=30 bound fits the cap, K=30' };
}

export function chooseListSize(
  train: TrainingData,
  devUsers: readonly DevUser[],
  judge: TargetJudge,
  k: KnnK,
  fitsCap: FitsCap,
): KDecision {
  return decideListSize(devCeilings(train, devUsers, judge, k), fitsCap);
}

// ---------------------------------------------------------------- 3. tuned-rerank weights

export interface WeightTrial {
  weights: TunedWeights;
  meanNdcg10: number;
  n: number;
}

export interface WeightTuning {
  weights: TunedWeights;
  /** One trial per grid entry, in grid order. */
  trials: WeightTrial[];
}

export function tuneTunedWeights(
  train: TrainingData,
  k: KnnK,
  devContexts: readonly UserContext[],
  judge: TargetJudge,
  grid: readonly TunedWeights[] = weightGrid(),
): WeightTuning {
  if (grid.length === 0) throw new Error('tuneTunedWeights: empty grid');
  const feats = devContexts.map((ctx) => ({ userKey: ctx.userKey, f: tunedFeatures(train, k, ctx) }));
  const trials: WeightTrial[] = grid.map((w) => ({
    weights: { ...w },
    meanNdcg10: mean(feats.map(({ userKey, f }) => judge.ndcgAt10(userKey, orderByWeights(f, w)))),
    n: devContexts.length,
  }));
  let best = trials[0];
  for (const t of trials.slice(1)) if (t.meanNdcg10 > best.meanNdcg10 + TIE_EPS) best = t;
  return { weights: { ...best.weights }, trials };
}

// ---------------------------------------------------------------- all three, in order

export interface DevTuning {
  k: KTuning;
  K: KDecision;
  /** K the weights were tuned at: the chosen K, or 20 when live is refused (local baselines still run). */
  weightsK: ListK;
  weights: WeightTuning;
}

export function tuneOnDev(input: {
  train: TrainingData;
  itemById: ReadonlyMap<number, Item>;
  devUsers: readonly DevUser[];
  judge: TargetJudge;
  fitsCap: FitsCap;
  kGrid?: readonly KnnK[];
}): DevTuning {
  const { train, itemById, devUsers, judge, fitsCap } = input;
  const k = tuneNeighbourhood(train, devUsers, judge, input.kGrid ?? KNN_K_GRID);
  const K = chooseListSize(train, devUsers, judge, k.k, fitsCap);
  const weightsK: ListK = K.ok ? K.K : 20;
  const contexts = devUsers.map((u) => buildUserContext(train, itemById, u, { k: k.k, K: weightsK }));
  const weights = tuneTunedWeights(train, k.k, contexts, judge);
  return { k, K, weightsK, weights };
}
