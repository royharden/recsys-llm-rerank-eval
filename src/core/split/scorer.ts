// The only holder of targets (PLAN §3). Import restricted by ESLint to src/core/metrics, src/core/report and split/ itself.
import { userKeyOf } from './manifest.ts';
import type { SplitResult } from './temporal.ts';

export interface Scorer {
  /** userKey → target itemId. */
  readonly targets: ReadonlyMap<string, number>;
}

/** Build the Scorer for the given users (e.g. split.devUserIds or split.heldoutUserIds) under the manifest salt. */
export function scorerFromSplit(split: SplitResult, userIds: readonly number[], salt: string): Scorer {
  const targets = new Map<string, number>();
  for (const u of userIds) {
    const t = split.users.get(u)?.target;
    if (!t) throw new Error(`scorerFromSplit: user ${u} has no target (not eligible)`);
    targets.set(userKeyOf(salt, u), t.itemId);
  }
  return { targets };
}

/** 1-based rank of the user's target in `ranked`, or null when absent. Throws for an unknown userKey. */
export function targetRank(scorer: Scorer, userKey: string, ranked: readonly number[]): number | null {
  const target = scorer.targets.get(userKey);
  if (target === undefined) throw new Error(`targetRank: unknown userKey ${userKey}`);
  const i = ranked.indexOf(target);
  return i === -1 ? null : i + 1;
}
