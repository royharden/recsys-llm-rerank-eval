// item-kNN (PLAN §3 [C neighbourhood + X tie rule]):
//   score(i) = Σ_{h ∈ history, i ∈ N_k(h)} sim(h, i),  N_k(h) = top-k neighbours of h,  k ∈ {20, 50, 100, 'all'}
//   pool = catalogue \ history (history excluded), ties → pre-T popularity desc, then item id asc.
// The itemknn arm returns ctx.candidates in order: candidates ARE the kNN top-kEff (built in candidates.ts).
import type { UserContext } from '../split/context.ts';
import type { TrainingData } from './train.ts';
import { localResult, type Arm } from './types.ts';

/** Neighbourhood size: a positive integer (≤ train.maxNeighbours) or 'all'. */
export type KnnK = number | 'all';

export const KNN_K_GRID: readonly KnnK[] = [20, 50, 100, 'all'];

function checkK(train: TrainingData, k: KnnK): void {
  if (k === 'all') return;
  if (!Number.isInteger(k) || k < 1) throw new Error(`itemknn: k must be a positive integer or 'all', got ${String(k)}`);
  if (k > train.maxNeighbours) {
    throw new Error(`itemknn: k=${k} exceeds the stored neighbour lists (maxNeighbours=${train.maxNeighbours}); rebuild TrainingData`);
  }
}

/** Distinct catalogue indices of the history, in first-seen (oldest-first) order. Items outside the catalogue are ignored. */
export function historyIndices(train: TrainingData, history: readonly number[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const id of history) {
    const i = train.index.get(id);
    if (i === undefined || seen.has(i)) continue;
    seen.add(i);
    out.push(i);
  }
  return out;
}

/**
 * kNN score of every catalogue item (by catalogue index) for this history. History items' own entries are whatever the
 * sum gives; callers exclude them from the pool. Deterministic: history is summed oldest first.
 */
export function knnScores(train: TrainingData, history: readonly number[], k: KnnK): Float64Array {
  checkK(train, k);
  const n = train.catalogue.length;
  const scores = new Float64Array(n);
  for (const h of historyIndices(train, history)) {
    const row = h * n;
    if (k === 'all') {
      for (let b = 0; b < n; b++) scores[b] += train.sim[row + b];
    } else {
      const m = Math.min(k, train.neighbourCount[h]);
      const base = h * train.maxNeighbours;
      for (let j = 0; j < m; j++) {
        const b = train.neighbours[base + j];
        scores[b] += train.sim[row + b];
      }
    }
  }
  return scores;
}

export interface KnnRanking {
  /** Ranked item ids (length min(limit, |pool|)). */
  ids: number[];
  /** kNN scores aligned with ids. */
  scores: number[];
  /** |catalogue \ history|. */
  poolSize: number;
}

/** Rank catalogue \ history by score desc → popularity desc → item id asc; return the first `limit`. */
export function knnRanking(train: TrainingData, history: readonly number[], k: KnnK, limit: number): KnnRanking {
  if (!Number.isInteger(limit) || limit < 0) throw new Error(`knnRanking: limit must be a non-negative integer, got ${limit}`);
  const scores = knnScores(train, history, k);
  const excluded = new Set(historyIndices(train, history));
  const pool: number[] = [];
  for (let i = 0; i < train.catalogue.length; i++) if (!excluded.has(i)) pool.push(i);
  const pop = train.popularity;
  const cat = train.catalogue;
  pool.sort((a, b) => scores[b] - scores[a] || pop[b] - pop[a] || cat[a] - cat[b]);
  const top = pool.slice(0, limit);
  return { ids: top.map((i) => cat[i]), scores: top.map((i) => scores[i]), poolSize: pool.length };
}

/** kNN scores for specific item ids (0 for items outside the catalogue). */
export function knnScoresFor(train: TrainingData, history: readonly number[], k: KnnK, itemIds: readonly number[]): number[] {
  const scores = knnScores(train, history, k);
  return itemIds.map((id) => {
    const i = train.index.get(id);
    return i === undefined ? 0 : scores[i];
  });
}

/** The itemknn arm: its ranking is the candidate list itself (kNN top-kEff, knnRank order). */
export function createItemKnnArm(): Arm {
  return {
    id: 'itemknn',
    kind: 'generator',
    rank(ctx: UserContext) {
      const ordered = [...ctx.candidates].sort((a, b) => a.knnRank - b.knnRank);
      return Promise.resolve(localResult(ordered.map((c) => c.itemId)));
    },
  };
}
