// random-rerank (PLAN §3): seeded Fisher–Yates permutation of the K candidates. The stream is derived from
// (seed, arm, userKey, repeatIndex), so a user's permutation is independent of which other users are ranked or in what order.
import type { UserContext } from '../split/context.ts';
import { rngFor, shuffle } from '../stats/prng.ts';
import { localResult, type RankOptions, type Reranker } from './types.ts';

export function createRandomRerankArm(seed: number): Reranker {
  if (!Number.isInteger(seed)) throw new Error(`random-rerank: seed must be an integer, got ${seed}`);
  return {
    id: 'random-rerank',
    kind: 'reranker',
    rank(ctx: UserContext, opts?: RankOptions) {
      const ids = [...ctx.candidates].sort((a, b) => a.knnRank - b.knnRank).map((c) => c.itemId);
      const rng = rngFor(seed, 'random-rerank', ctx.userKey, opts?.repeatIndex ?? 0);
      return Promise.resolve(localResult(shuffle(ids, rng)));
    },
  };
}
