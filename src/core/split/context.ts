// What arms, prompts, probes and providers may see about a user (PLAN §3). There is deliberately NO target field:
// the target lives only in the Scorer (split/scorer.ts), which only metrics/ and report/ import.
import type { CandidateItem, PromptItem } from '../contracts/types.ts';
import type { Interaction, Item } from '../data/types.ts';

export const PROMPT_HISTORY_MAX = 30;

export type UserFlag = 'short_list' | 'no_candidates';

export interface UserContext {
  readonly userKey: string;
  /** Full pre-T history item ids, oldest first in (ts, itemId) order. */
  readonly history: readonly number[];
  /** Last <= 30 history items, oldest first. */
  readonly promptHistory: readonly PromptItem[];
  /** item-kNN top-kEff, knnRank 1..kEff. */
  readonly candidates: readonly CandidateItem[];
  /** min(K, |catalogue \ history|). */
  readonly kEff: number;
  readonly flags: readonly UserFlag[];
}

/** History item ids, oldest first. Input rows must already be the pre-T history from splitAt. */
export function historyIds(history: readonly Interaction[]): number[] {
  return history.map((r) => r.itemId);
}

/** The last `max` history items as PromptItems, oldest first. Items unknown to the catalogue map are skipped. */
export function promptHistoryOf(
  history: readonly number[],
  itemById: ReadonlyMap<number, Item>,
  max: number = PROMPT_HISTORY_MAX,
): PromptItem[] {
  const out: PromptItem[] = [];
  for (const id of history.slice(Math.max(0, history.length - max))) {
    const it = itemById.get(id);
    if (it) out.push({ itemId: it.itemId, title: it.title, year: it.year, genres: it.genres.slice() });
  }
  return out;
}

/** kEff and flags for a candidate pool of `available` = |catalogue \ history| items (PLAN §3). */
export function kEffOf(K: number, available: number): { kEff: number; flags: UserFlag[] } {
  const kEff = Math.max(0, Math.min(K, available));
  const flags: UserFlag[] = [];
  if (kEff < K) flags.push('short_list');
  if (kEff === 0) flags.push('no_candidates');
  return { kEff, flags };
}
