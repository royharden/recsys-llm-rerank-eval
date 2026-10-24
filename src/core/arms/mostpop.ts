// mostpop (PLAN §3): pre-T distinct-user count desc, then item id asc; the user's history excluded. Its pool is the same
// catalogue \ history as item-kNN's, so its list length is ctx.kEff.
import type { UserContext } from '../split/context.ts';
import type { TrainingData } from './train.ts';
import { localResult, type Arm } from './types.ts';

/** The `limit` most popular catalogue items not in `history`. */
export function mostPopular(train: TrainingData, history: readonly number[], limit: number): number[] {
  const excluded = new Set(history);
  const out: number[] = [];
  for (let j = 0; j < train.popularityOrder.length && out.length < limit; j++) {
    const id = train.catalogue[train.popularityOrder[j]];
    if (!excluded.has(id)) out.push(id);
  }
  return out;
}

export function createMostPopArm(train: TrainingData): Arm {
  return {
    id: 'mostpop',
    kind: 'generator',
    rank(ctx: UserContext) {
      return Promise.resolve(localResult(mostPopular(train, ctx.history, ctx.kEff)));
    },
  };
}
