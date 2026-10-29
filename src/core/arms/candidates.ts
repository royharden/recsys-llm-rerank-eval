// Candidate construction (PLAN §3): candidates = item-kNN top-kEff over catalogue \ history,
// kEff = min(K, |catalogue \ history|); kEff < K → 'short_list'; kEff = 0 → 'no_candidates' (kept as a miss for every arm,
// no model call). The target is never injected: this module has no access to it.
import type { CandidateItem } from '../contracts/types.ts';
import type { Item } from '../data/types.ts';
import { kEffOf, promptHistoryOf, type UserContext, type UserFlag } from '../split/context.ts';
import { knnRanking, type KnnK } from './itemknn.ts';
import type { TrainingData } from './train.ts';

/** The list size K is chosen on dev from {20, 30} (PLAN §3; K = 10 excluded because it cannot change HR@10). */
export const LIST_K_GRID = [20, 30] as const;
export type ListK = (typeof LIST_K_GRID)[number];

export interface CandidateList {
  candidates: CandidateItem[];
  kEff: number;
  flags: UserFlag[];
  /** kNN scores aligned with candidates (for diagnostics; never sent to a model). */
  scores: number[];
}

/** kNN top-kEff as CandidateItems (knnRank 1..kEff). Throws if a catalogue item has no u.item metadata. */
export function buildCandidates(
  train: TrainingData,
  itemById: ReadonlyMap<number, Item>,
  history: readonly number[],
  k: KnnK,
  K: number,
): CandidateList {
  if (!Number.isInteger(K) || K < 1) throw new Error(`buildCandidates: K must be a positive integer, got ${K}`);
  const ranking = knnRanking(train, history, k, K);
  const { kEff, flags } = kEffOf(K, ranking.poolSize);
  const candidates: CandidateItem[] = ranking.ids.slice(0, kEff).map((id, i) => {
    const it = itemById.get(id);
    if (!it) throw new Error(`buildCandidates: catalogue item ${id} missing from u.item`);
    return { itemId: it.itemId, title: it.title, year: it.year, genres: it.genres.slice(), knnRank: i + 1 };
  });
  return { candidates, kEff, flags, scores: ranking.scores.slice(0, kEff) };
}

export interface ContextParams {
  k: KnnK;
  K: number;
}

/** Build one user's UserContext from their pre-T history (item ids, oldest first). */
export function buildUserContext(
  train: TrainingData,
  itemById: ReadonlyMap<number, Item>,
  user: { userKey: string; history: readonly number[] },
  params: ContextParams,
): UserContext {
  const { candidates, kEff, flags } = buildCandidates(train, itemById, user.history, params.k, params.K);
  return {
    userKey: user.userKey,
    history: user.history.slice(),
    promptHistory: promptHistoryOf(user.history, itemById),
    candidates,
    kEff,
    flags,
  };
}

