// Presentation order per variant (PLAN §4 probes) and the seeded probe sample. Core-only (uses stats/prng), so it is
// NOT in the vendored set: the client decides presentation order and sends it as array order; the server only labels.
// Sees a UserContext (no target) and never imports split/temporal or split/scorer.
//
// llm-list: base / masked / repeat → history oldest first, candidates in knnRank order
//           hist_shuffle           → history seeded-shuffled, candidates in knnRank order
//           cand_reversed          → candidates in reverse knnRank order
//           cand_shuffled          → candidates seeded-shuffled (the position-bias probe)
// jev-point: base                 → question order seeded-shuffled (always, PLAN §4)
//            q_shuffle            → a second, independent seeded question order
import type { CandidateItem, PromptItem } from '../contracts/types.ts';
import { ARM_VARIANTS, type ModelArmId, type Variant } from '../contracts/rerank-payload.ts';
import type { UserContext } from '../split/context.ts';
import { rngFor, shuffle } from '../stats/prng.ts';

export const LLM_LIST_PROBES: readonly Variant[] = ['hist_shuffle', 'cand_reversed', 'cand_shuffled', 'masked', 'repeat'];
export const JEV_PROBES: readonly Variant[] = ['q_shuffle'];
export const PROBES_BY_ARM: Readonly<Record<ModelArmId, readonly Variant[]>> = {
  'llm-list': LLM_LIST_PROBES,
  'jev-point': JEV_PROBES,
};
export const PROBE_SAMPLE_MAX = 150;

export function repeatIndexFor(variant: Variant): 0 | 1 {
  return variant === 'repeat' ? 1 : 0;
}

export function checkVariant(arm: ModelArmId, variant: string): Variant {
  const allowed = ARM_VARIANTS[arm] as readonly string[];
  if (!allowed.includes(variant)) throw new Error(`variant ${variant} is not valid for ${arm}`);
  return variant as Variant;
}

export interface Presentation {
  history: PromptItem[];
  candidates: CandidateItem[];
}

function copyItem<T extends PromptItem>(it: T): T {
  return { ...it, genres: it.genres.slice() };
}

export function presentation(ctx: UserContext, arm: ModelArmId, variant: Variant, seed: number): Presentation {
  checkVariant(arm, variant);
  const history = ctx.promptHistory.map(copyItem);
  const knn = [...ctx.candidates].sort((a, b) => a.knnRank - b.knnRank).map(copyItem);
  if (arm === 'jev-point') {
    const rng = rngFor(seed, 'jev-question-order', ctx.userKey, variant);
    return { history, candidates: shuffle(knn, rng) };
  }
  switch (variant) {
    case 'hist_shuffle':
      return { history: shuffle(history, rngFor(seed, 'hist_shuffle', ctx.userKey)), candidates: knn };
    case 'cand_reversed':
      return { history, candidates: knn.reverse() };
    case 'cand_shuffled':
      return { history, candidates: shuffle(knn, rngFor(seed, 'cand_shuffled', ctx.userKey)) };
    default:
      return { history, candidates: knn };
  }
}

/** Seeded probe sample: min(max, n) userKeys, returned ascending. Independent of input order. */
export function sampleProbeUsers(userKeys: readonly string[], seed: number, max: number = PROBE_SAMPLE_MAX): string[] {
  const sorted = [...new Set(userKeys)].sort();
  const picked = shuffle(sorted, rngFor(seed, 'probe-sample')).slice(0, Math.min(max, sorted.length));
  return picked.sort();
}
