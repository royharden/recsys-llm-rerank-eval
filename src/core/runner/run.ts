// Target-blind scheduler. Scoring is injected from metrics/report, never by passing a Scorer to an arm.
import { isModelArm } from '../arms/model-arm.ts';
import { isPermutationOf, type Arm } from '../arms/types.ts';
import type { Variant } from '../contracts/rerank-payload.ts';
import type { Ledger } from '../ledger/types.ts';
import type { UserEval, UserRanking } from '../metrics/ranking.ts';
import { PROBES_BY_ARM, repeatIndexFor } from '../probes/orderprobe.ts';
import type { UserContext } from '../split/context.ts';
import { resultKey, type ResultKey, type ResultRow, type ResultStore, type RunIdentity } from './store.ts';

export interface RunInput {
  identity: RunIdentity;
  contexts: readonly UserContext[];
  arms: readonly Arm[];
  probeUserKeys: ReadonlySet<string>;
  store: ResultStore;
  ledger: Ledger;
  evaluate: (ranking: UserRanking) => UserEval;
  signal?: AbortSignal;
  onProgress?: (progress: { completed: number; expected: number; resumed: number }) => void | Promise<void>;
  /** M4 supplies approved->running / incomplete / complete RPCs here. Local mock leaves them absent. */
  lifecycle?: { start(): Promise<void>; incomplete(reason: string): Promise<void>; complete(): Promise<void> };
}

export function expectedResults(input: Pick<RunInput, 'identity' | 'contexts' | 'arms' | 'probeUserKeys'>): ResultKey[] {
  const keys: ResultKey[] = [];
  for (const arm of input.arms) for (const ctx of input.contexts) {
    const variants: readonly Variant[] = isModelArm(arm) && input.probeUserKeys.has(ctx.userKey)
      ? ['base', ...PROBES_BY_ARM[arm.id]] : ['base'];
    for (const variant of variants) keys.push({ runId: input.identity.runId, arm: arm.id, userKey: ctx.userKey,
      variant, repeatIndex: repeatIndexFor(variant) });
  }
  if (new Set(keys.map(resultKey)).size !== keys.length) throw new Error('duplicate arm/user result keys');
  return keys;
}

export async function runEvaluation(input: RunInput): Promise<ResultRow[]> {
  const { identity, store, ledger } = input;
  await store.bind(identity);
  const expected = expectedResults(input);
  const contexts = new Map(input.contexts.map((ctx) => [ctx.userKey, ctx]));
  const arms = new Map(input.arms.map((arm) => [arm.id, arm]));
  const persistedCalls = new Set((await store.calls()).map((call) => call.id));
  const persistCalls = async (): Promise<void> => {
    for (const row of ledger.rows({ runId: identity.runId })) if (!persistedCalls.has(row.id)) {
      await store.appendCall(row); persistedCalls.add(row.id);
    }
  };
  let completed = 0;
  let resumed = 0;
  await input.lifecycle?.start();
  try {
    for (const key of expected) {
      if (input.signal?.aborted) throw new Error('cancelled');
      if (await store.get(key)) { resumed++; completed++; }
      else {
        const ctx = contexts.get(key.userKey)!;
        const arm = arms.get(key.arm)!;
        const opts = { variant: key.variant, repeatIndex: key.repeatIndex, runId: identity.runId, signal: input.signal };
        const detail = isModelArm(arm) ? await arm.rankDetailed(ctx, opts) : null;
        const ranked = detail?.result ?? await arm.rank(ctx, opts);
        const candidateIds = ctx.candidates.map((c) => c.itemId);
        if (arm.kind === 'reranker' && !isPermutationOf(ranked.order, candidateIds)) throw new Error(`${arm.id}: non-permutation`);
        const evaluation = input.evaluate({ userKey: ctx.userKey, order: ranked.order, candidateIds, kEff: ctx.kEff, flags: ctx.flags });
        await persistCalls();
        await store.put({ ...key, candidateIds, rankedIds: ranked.order, presentedIds: detail?.presentedIds ?? [],
          kEff: ctx.kEff, flags: [...ctx.flags], targetRank: evaluation.rank, inCandidates: evaluation.targetInCandidates,
          targetPopularity: evaluation.targetPopularity, coldTarget: evaluation.coldTarget,
          repairs: ranked.repairs, formatFailure: ranked.formatFailure, callIds: ranked.callIds });
        completed++;
      }
      await input.onProgress?.({ completed, expected: expected.length, resumed });
    }
    const rows = await store.rows();
    const wanted = new Set(expected.map(resultKey));
    if (rows.length !== wanted.size || rows.some((row) => !wanted.has(resultKey(row)))) throw new Error('result set differs from frozen expectation');
    await input.lifecycle?.complete();
    return rows;
  } catch (error) {
    await persistCalls();
    await input.lifecycle?.incomplete(error instanceof Error ? error.message : 'run failed');
    throw error;
  }
}
