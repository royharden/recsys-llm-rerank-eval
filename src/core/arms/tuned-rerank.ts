// tuned-rerank (PLAN §3): a non-LLM reranker of the K candidates with three features
//   knn     = min-max normalised kNN score over this user's candidates (all 0 when the scores are constant)
//   recency = mean cosine between the candidate and the last ≤ 5 history items (0 when none are in the catalogue)
//   genre   = cosine between the candidate's genre vector and the user's genre profile (Σ genre vectors over the full history)
// score = w.knn·knn + w.recency·recency + w.genre·genre with convex weights on a 0.25 grid (sum 1), tuned on dev NDCG@10.
// Ties → kNN order (knnRank asc). Output is always a permutation of the candidates.
import type { CandidateItem } from '../contracts/types.ts';
import type { UserContext } from '../split/context.ts';
import { historyIndices, knnScoresFor, type KnnK } from './itemknn.ts';
import { GENRE_COUNT, type TrainingData } from './train.ts';
import { localResult, type Reranker } from './types.ts';

export const RECENCY_WINDOW = 5;

export interface TunedWeights {
  knn: number;
  recency: number;
  genre: number;
}

/** The 15 convex weight triples on the 0.25 grid, ordered knn desc, then recency desc (tuning tie order). */
export function weightGrid(): TunedWeights[] {
  const out: TunedWeights[] = [];
  for (let a = 4; a >= 0; a--) {
    for (let b = 4 - a; b >= 0; b--) {
      out.push({ knn: a / 4, recency: b / 4, genre: (4 - a - b) / 4 });
    }
  }
  return out;
}

export function checkWeights(w: TunedWeights): void {
  const parts = [w.knn, w.recency, w.genre];
  for (const p of parts) {
    if (!(p >= 0 && p <= 1) || !Number.isInteger(p * 4)) throw new Error(`tuned-rerank: weight ${p} is not on the 0.25 grid`);
  }
  if (parts.reduce((s, p) => s + p * 4, 0) !== 4) throw new Error('tuned-rerank: weights must sum to 1');
}

export interface CandidateFeatures {
  itemId: number;
  knnRank: number;
  knnRaw: number;
  knn: number;
  recency: number;
  genre: number;
}

function sortedCandidates(ctx: UserContext): CandidateItem[] {
  return [...ctx.candidates].sort((a, b) => a.knnRank - b.knnRank);
}

/** Feature vectors for every candidate, in knnRank order. */
export function tunedFeatures(train: TrainingData, k: KnnK, ctx: UserContext): CandidateFeatures[] {
  const cands = sortedCandidates(ctx);
  if (cands.length === 0) return [];
  const n = train.catalogue.length;
  const ids = cands.map((c) => c.itemId);
  const raw = knnScoresFor(train, ctx.history, k, ids);
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of raw) {
    if (s < lo) lo = s;
    if (s > hi) hi = s;
  }
  const span = hi - lo;

  const hist = historyIndices(train, ctx.history);
  const recent = historyIndices(train, ctx.history.slice(Math.max(0, ctx.history.length - RECENCY_WINDOW)));

  const profile = new Float64Array(GENRE_COUNT);
  for (const h of hist) for (let g = 0; g < GENRE_COUNT; g++) profile[g] += train.genres[h * GENRE_COUNT + g];
  let profileNorm = 0;
  for (let g = 0; g < GENRE_COUNT; g++) profileNorm += profile[g] * profile[g];
  profileNorm = Math.sqrt(profileNorm);

  return cands.map((c, j) => {
    const ci = train.index.get(c.itemId);
    let recency = 0;
    let genre = 0;
    if (ci !== undefined) {
      if (recent.length > 0) {
        let s = 0;
        for (const h of recent) s += train.sim[h * n + ci];
        recency = s / recent.length;
      }
      let dot = 0;
      let cnt = 0;
      for (let g = 0; g < GENRE_COUNT; g++) {
        const v = train.genres[ci * GENRE_COUNT + g];
        dot += v * profile[g];
        cnt += v;
      }
      if (cnt > 0 && profileNorm > 0) genre = dot / (Math.sqrt(cnt) * profileNorm);
    }
    return {
      itemId: c.itemId,
      knnRank: c.knnRank,
      knnRaw: raw[j],
      knn: span > 0 ? (raw[j] - lo) / span : 0,
      recency,
      genre,
    };
  });
}

/** Order features by weighted score desc, ties → knnRank asc. */
export function orderByWeights(features: readonly CandidateFeatures[], w: TunedWeights): number[] {
  const scored = features.map((f) => ({ f, s: w.knn * f.knn + w.recency * f.recency + w.genre * f.genre }));
  scored.sort((a, b) => b.s - a.s || a.f.knnRank - b.f.knnRank);
  return scored.map((x) => x.f.itemId);
}

export function createTunedRerankArm(train: TrainingData, k: KnnK, weights: TunedWeights): Reranker {
  checkWeights(weights);
  return {
    id: 'tuned-rerank',
    kind: 'reranker',
    rank(ctx: UserContext) {
      return Promise.resolve(localResult(orderByWeights(tunedFeatures(train, k, ctx), weights)));
    },
  };
}
