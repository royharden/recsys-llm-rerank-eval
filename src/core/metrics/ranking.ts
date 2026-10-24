// Ranking metrics (PLAN §5). One target per user at 1-based rank r (null when absent):
//   HR@10 = [r ≤ 10];  NDCG@10 = [r ≤ 10] / log2(r + 1);  MRR@K = 1/r if r ≤ K else 0.
// Shared ceiling = share of users whose target is in the kNN top-K candidates (mostpop additionally reports its own
// top-K share). coverage@10 = |∪ top-10| / |catalogue|. novelty = mean −log2(pop(i)/Σpop) over all recommended top-10
// (user, item) pairs, pop = pre-T distinct-user count. head share = share of recommended top-10 pairs in the head set
// (top 10% most popular catalogue items). Anything that cannot be computed is a typed "unavailable: <reason>", never NaN.
// This module may import the Scorer (ESLint allows metrics/); arms may not.
import type { UserFlag } from '../split/context.ts';
import { targetRank, type Scorer } from '../split/scorer.ts';
import type { TargetJudge } from '../arms/tuning.ts';
import { headItems, popularityOf, type TrainingData } from '../arms/train.ts';

export const CUTOFF = 10;

// ---------------------------------------------------------------- typed values

export type MetricValue = { kind: 'value'; value: number } | { kind: 'unavailable'; reason: string };

export function metricValue(value: number): MetricValue {
  if (!Number.isFinite(value)) throw new Error(`metricValue: non-finite value ${value}`);
  return { kind: 'value', value };
}

export function unavailable(reason: string): MetricValue {
  return { kind: 'unavailable', reason };
}

export function isAvailable(v: MetricValue): v is { kind: 'value'; value: number } {
  return v.kind === 'value';
}

/** "0.1234" or "unavailable: <reason>". */
export function formatMetric(v: MetricValue, digits = 4): string {
  return v.kind === 'value' ? v.value.toFixed(digits) : `unavailable: ${v.reason}`;
}

function meanOf(xs: readonly number[], emptyReason: string): MetricValue {
  if (xs.length === 0) return unavailable(emptyReason);
  let s = 0;
  for (const x of xs) s += x;
  return metricValue(s / xs.length);
}

// ---------------------------------------------------------------- per-rank formulas

export function rankIn(target: number, order: readonly number[]): number | null {
  const i = order.indexOf(target);
  return i === -1 ? null : i + 1;
}

export function hitAt10(rank: number | null): number {
  return rank !== null && rank <= CUTOFF ? 1 : 0;
}

export function ndcgAt10(rank: number | null): number {
  return rank !== null && rank <= CUTOFF ? 1 / Math.log2(rank + 1) : 0;
}

/** Reciprocal rank truncated at K (MRR@K term). */
export function reciprocalRankAtK(rank: number | null, K: number): number {
  return rank !== null && rank <= K ? 1 / rank : 0;
}

/** A TargetJudge for dev tuning, backed by the Scorer. */
export function judgeFromScorer(scorer: Scorer): TargetJudge {
  return {
    rankOf: (userKey, order) => targetRank(scorer, userKey, order),
    ndcgAt10: (userKey, order) => ndcgAt10(targetRank(scorer, userKey, order)),
  };
}

// ---------------------------------------------------------------- per-user evaluation

export interface UserRanking {
  userKey: string;
  /** The arm's ranked ids (empty when kEff = 0). */
  order: readonly number[];
  /** The kNN top-K candidate ids for this user (the shared ceiling pool). */
  candidateIds: readonly number[];
  kEff: number;
  flags: readonly UserFlag[];
}

export interface UserEval {
  userKey: string;
  rank: number | null;
  hit10: number;
  ndcg10: number;
  rrK: number;
  /** Target ∈ kNN top-K (shared ceiling). */
  targetInCandidates: boolean;
  /** Target ∈ this arm's own list (mostpop's own-pool share). */
  targetInOwnList: boolean;
  /** Pre-T distinct-user count of the target (0 = cold target). */
  targetPopularity: number;
  coldTarget: boolean;
  /** First ≤ 10 ids of the arm's list. */
  top10: number[];
  kEff: number;
  flags: readonly UserFlag[];
}

export function evaluateUser(scorer: Scorer, train: TrainingData, ranking: UserRanking, K: number): UserEval {
  const target = scorer.targets.get(ranking.userKey);
  if (target === undefined) throw new Error(`evaluateUser: unknown userKey ${ranking.userKey}`);
  const rank = rankIn(target, ranking.order);
  const targetPopularity = popularityOf(train, target);
  return {
    userKey: ranking.userKey,
    rank,
    hit10: hitAt10(rank),
    ndcg10: ndcgAt10(rank),
    rrK: reciprocalRankAtK(rank, K),
    targetInCandidates: ranking.candidateIds.includes(target),
    targetInOwnList: rank !== null && rank <= K,
    targetPopularity,
    coldTarget: !train.index.has(target),
    top10: ranking.order.slice(0, CUTOFF),
    kEff: ranking.kEff,
    flags: ranking.flags,
  };
}

export function evaluateUsers(scorer: Scorer, train: TrainingData, rankings: readonly UserRanking[], K: number): UserEval[] {
  return rankings.map((r) => evaluateUser(scorer, train, r, K));
}

// ---------------------------------------------------------------- aggregates

export interface CoreMetrics {
  n: number;
  hr10: MetricValue;
  ndcg10: MetricValue;
  mrrK: MetricValue;
}

export function coreMetrics(evals: readonly UserEval[], emptyReason = 'no users'): CoreMetrics {
  return {
    n: evals.length,
    hr10: meanOf(evals.map((e) => e.hit10), emptyReason),
    ndcg10: meanOf(evals.map((e) => e.ndcg10), emptyReason),
    mrrK: meanOf(evals.map((e) => e.rrK), emptyReason),
  };
}

/** Shared ceiling: share of users whose target is in the kNN top-K. */
export function ceiling(evals: readonly UserEval[]): MetricValue {
  return meanOf(evals.map((e) => (e.targetInCandidates ? 1 : 0)), 'no users');
}

/** Own-pool share: share of users whose target is in this arm's own top-K (reported for mostpop). */
export function ownPoolShare(evals: readonly UserEval[]): MetricValue {
  return meanOf(evals.map((e) => (e.targetInOwnList ? 1 : 0)), 'no users');
}

function recommendedPairs(evals: readonly UserEval[]): number[] {
  const out: number[] = [];
  for (const e of evals) for (const id of e.top10) out.push(id);
  return out;
}

export function coverageAt10(evals: readonly UserEval[], train: TrainingData): MetricValue {
  if (train.catalogue.length === 0) return unavailable('empty catalogue');
  const pairs = recommendedPairs(evals);
  if (pairs.length === 0) return unavailable('no recommendations');
  return metricValue(new Set(pairs).size / train.catalogue.length);
}

/** Mean self-information −log2(pop(i)/Σpop) over recommended top-10 pairs. Items with pop 0 cannot occur in a list
 * built from the catalogue; if one does, novelty is unavailable rather than infinite. */
export function noveltyAt10(evals: readonly UserEval[], train: TrainingData): MetricValue {
  if (!(train.totalPopularity > 0)) return unavailable('no pre-T popularity');
  const pairs = recommendedPairs(evals);
  if (pairs.length === 0) return unavailable('no recommendations');
  let s = 0;
  for (const id of pairs) {
    const p = popularityOf(train, id);
    if (p <= 0) return unavailable(`recommended item ${id} has no pre-T popularity`);
    s += -Math.log2(p / train.totalPopularity);
  }
  return metricValue(s / pairs.length);
}

export function headShareAt10(evals: readonly UserEval[], train: TrainingData): MetricValue {
  if (train.catalogue.length === 0) return unavailable('empty catalogue');
  const pairs = recommendedPairs(evals);
  if (pairs.length === 0) return unavailable('no recommendations');
  const head = headItems(train);
  let h = 0;
  for (const id of pairs) if (head.has(id)) h++;
  return metricValue(h / pairs.length);
}

// ---------------------------------------------------------------- exploratory rows

export interface ConditionalMetrics extends CoreMetrics {
  /** Always exploratory: users whose target is in the kNN top-K, with their own n. */
  subset: 'target_in_candidates';
}

export function conditionalOnTargetInK(evals: readonly UserEval[]): ConditionalMetrics {
  return { subset: 'target_in_candidates', ...coreMetrics(evals.filter((e) => e.targetInCandidates), 'no user has the target in K') };
}

export type Tercile = 'low' | 'mid' | 'high';
export const TERCILES: readonly Tercile[] = ['low', 'mid', 'high'];

export interface TercileRow {
  tercile: Tercile;
  n: number;
  /** Target popularity range in this tercile (null when empty). */
  popMin: number | null;
  popMax: number | null;
  ndcg10: MetricValue;
  hr10: MetricValue;
}

/**
 * Equal-count popularity terciles of the target: users sorted by (target popularity asc, userKey asc); the user at sorted
 * position i (of n) is in tercile floor(3i/n). The assignment depends only on targets, so it is identical for every arm
 * evaluated on the same users.
 */
export function tercileOf(evals: readonly UserEval[]): Map<string, Tercile> {
  const sorted = [...evals].sort(
    (a, b) => a.targetPopularity - b.targetPopularity || (a.userKey < b.userKey ? -1 : a.userKey > b.userKey ? 1 : 0),
  );
  const out = new Map<string, Tercile>();
  sorted.forEach((e, i) => out.set(e.userKey, TERCILES[Math.floor((3 * i) / sorted.length)]));
  return out;
}

export function popularityTerciles(evals: readonly UserEval[]): TercileRow[] {
  const assign = tercileOf(evals);
  return TERCILES.map((t) => {
    const group = evals.filter((e) => assign.get(e.userKey) === t);
    const pops = group.map((e) => e.targetPopularity);
    return {
      tercile: t,
      n: group.length,
      popMin: pops.length ? Math.min(...pops) : null,
      popMax: pops.length ? Math.max(...pops) : null,
      ndcg10: meanOf(group.map((e) => e.ndcg10), 'no users in tercile'),
      hr10: meanOf(group.map((e) => e.hit10), 'no users in tercile'),
    };
  });
}

// ---------------------------------------------------------------- one arm's summary

export interface ArmMetrics extends CoreMetrics {
  ceiling: MetricValue;
  ownPoolShare: MetricValue;
  coverage10: MetricValue;
  novelty10: MetricValue;
  headShare10: MetricValue;
  coldTargets: number;
  shortLists: number;
  noCandidates: number;
  conditional: ConditionalMetrics;
  terciles: TercileRow[];
}

export function summarizeArm(evals: readonly UserEval[], train: TrainingData): ArmMetrics {
  return {
    ...coreMetrics(evals),
    ceiling: ceiling(evals),
    ownPoolShare: ownPoolShare(evals),
    coverage10: coverageAt10(evals, train),
    novelty10: noveltyAt10(evals, train),
    headShare10: headShareAt10(evals, train),
    coldTargets: evals.filter((e) => e.coldTarget).length,
    shortLists: evals.filter((e) => e.flags.includes('short_list')).length,
    noCandidates: evals.filter((e) => e.flags.includes('no_candidates')).length,
    conditional: conditionalOnTargetInK(evals),
    terciles: popularityTerciles(evals),
  };
}

// ---------------------------------------------------------------- paired vectors for the bootstrap

export type PerUserMetric = 'ndcg10' | 'hit10' | 'rrK';

/** Per-user metric vectors of two arms aligned on the same users (order of `a`). Throws if the user sets differ. */
export function pairedVectors(
  a: readonly UserEval[],
  b: readonly UserEval[],
  metric: PerUserMetric = 'ndcg10',
): { userKeys: string[]; a: number[]; b: number[] } {
  if (a.length !== b.length) throw new Error(`pairedVectors: ${a.length} vs ${b.length} users`);
  const byKey = new Map<string, UserEval>();
  for (const e of b) byKey.set(e.userKey, e);
  if (byKey.size !== b.length) throw new Error('pairedVectors: duplicate userKey');
  const userKeys: string[] = [];
  const va: number[] = [];
  const vb: number[] = [];
  for (const e of a) {
    const o = byKey.get(e.userKey);
    if (!o) throw new Error(`pairedVectors: user ${e.userKey} missing from the comparison arm`);
    userKeys.push(e.userKey);
    va.push(e[metric]);
    vb.push(o[metric]);
  }
  return { userKeys, a: va, b: vb };
}
