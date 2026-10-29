// One interface for all six arms (PLAN §3/§4, M2 acceptance (a)). Arms see only a UserContext — never a target:
// they must not import split/scorer.ts (ESLint-enforced); only metrics/ and report/ may.
import type { UserContext } from '../split/context.ts';

export const ARM_IDS = ['mostpop', 'itemknn', 'random-rerank', 'tuned-rerank', 'llm-list', 'jev-point'] as const;

export type ArmId = (typeof ARM_IDS)[number];

/** generator = builds its own list from the catalogue; reranker = returns a permutation of ctx.candidates. */
export type ArmKind = 'generator' | 'reranker';

export const ARM_KIND: Readonly<Record<ArmId, ArmKind>> = {
  mostpop: 'generator',
  itemknn: 'generator',
  'random-rerank': 'reranker',
  'tuned-rerank': 'reranker',
  'llm-list': 'reranker',
  'jev-point': 'reranker',
};

/** Arms whose output comes from a model call (implemented in M3). */
export const LLM_ARM_IDS: readonly ArmId[] = ['llm-list', 'jev-point'];

/** rerankguard repair counters (PLAN §4). Always zero for the deterministic baselines. */
export interface RepairCounts {
  unknown: number;
  repeat: number;
  missing: number;
  emptyRanking: number;
}

export function zeroRepairs(): RepairCounts {
  return { unknown: 0, repeat: 0, missing: 0, emptyRanking: 0 };
}

export interface RankResult {
  /** Ranked item ids. Generators: length ctx.kEff; rerankers: a permutation of ctx.candidates' ids. */
  order: number[];
  repairs: RepairCounts;
  /** True when the arm fell back to kNN order because the model output was unusable (stays in denominators). */
  formatFailure: boolean;
  /** Ledger call ids (llm_calls.id / request keys) that produced this result; empty for local baselines. */
  callIds: string[];
}

export interface RankOptions {
  /** Prompt/probe variant (e.g. 'base', 'cand_shuffled'); baselines ignore it. */
  variant?: string;
  /** 0 for the base call, 1 for the repeat probe (PLAN §4 keys). */
  repeatIndex?: number;
  /** Run id, used by model arms for request keys. */
  runId?: string;
  signal?: AbortSignal;
}

export interface Arm {
  readonly id: ArmId;
  readonly kind: ArmKind;
  rank(ctx: UserContext, opts?: RankOptions): Promise<RankResult>;
}

/** A reranker is an Arm whose order is always a permutation of ctx.candidates. */
export type Reranker = Arm & { readonly kind: 'reranker' };

/** A deterministic, call-free result. */
export function localResult(order: number[]): RankResult {
  return { order, repairs: zeroRepairs(), formatFailure: false, callIds: [] };
}

/** True when `order` is a permutation of the candidate ids (same multiset, no extras, no repeats). */
export function isPermutationOf(order: readonly number[], candidateIds: readonly number[]): boolean {
  if (order.length !== candidateIds.length) return false;
  const want = new Set(candidateIds);
  if (want.size !== candidateIds.length) return false;
  const seen = new Set<number>();
  for (const id of order) {
    if (!want.has(id) || seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}
