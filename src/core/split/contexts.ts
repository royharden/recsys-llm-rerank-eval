// Target-bearing split objects stop here; arms receive pre-T histories only.
import { buildUserContext, type ContextParams } from '../arms/candidates.ts';
import type { TrainingData } from '../arms/train.ts';
import type { Item } from '../data/types.ts';
import { historyIds, type UserContext } from './context.ts';
import { userKeyOf } from './manifest.ts';
import type { SplitResult } from './temporal.ts';

export function devUsersOf(split: SplitResult, userIds: readonly number[], salt: string): { userKey: string; history: number[] }[] {
  return userIds.map((id) => {
    const user = split.users.get(id);
    if (!user) throw new Error(`devUsersOf: unknown user ${id}`);
    return { userKey: userKeyOf(salt, id), history: historyIds(user.history) };
  });
}

export function contextsForUsers(split: SplitResult, ids: readonly number[], salt: string, train: TrainingData,
  items: ReadonlyMap<number, Item>, params: ContextParams): UserContext[] {
  if (train.T !== split.T) throw new Error('contextsForUsers: training cut differs from split');
  return devUsersOf(split, ids, salt).map((u) => buildUserContext(train, items, u, params));
}
