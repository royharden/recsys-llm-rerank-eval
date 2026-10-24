// The target-aware composition root. All arm inputs are target-free UserContexts.
import { buildTrainingData } from '../arms/train.ts';
import { tuneOnDev } from '../arms/tuning.ts';
import { createLlmListArm } from '../arms/llm-list.ts';
import { createJevPointArm } from '../arms/jev-point.ts';
import type { ModelArmConfig } from '../arms/model-arm.ts';
import type { Dataset } from '../data/types.ts';
import { evaluateUser, judgeFromScorer, ndcgAt10, type UserRanking } from '../metrics/ranking.ts';
import { PROBES_BY_ARM } from '../probes/orderprobe.ts';
import type { RerankClient } from '../providers/types.ts';
import type { Manifest } from '../split/manifest.ts';
import { contextsForUsers, devUsersOf } from '../split/contexts.ts';
import { scorerFromSplit, targetRank } from '../split/scorer.ts';
import type { SplitResult } from '../split/temporal.ts';
import { hashCanonical } from '../util/hash.ts';

export function prepareEvaluation(dataset: Dataset, manifest: Manifest, split: SplitResult) {
  const train = buildTrainingData(dataset.interactions, split.T, dataset.items);
  const devScorer = scorerFromSplit(split, split.devUserIds, manifest.salt);
  const heldoutScorer = scorerFromSplit(split, split.heldoutUserIds, manifest.salt);
  const tuning = tuneOnDev({ train, itemById: dataset.itemById,
    devUsers: devUsersOf(split, split.devUserIds, manifest.salt), judge: judgeFromScorer(devScorer), fitsCap: () => true });
  if (!tuning.K.ok) throw new Error(tuning.K.reason);
  const params = { k: tuning.k.k, K: tuning.K.K };
  const devContexts = contextsForUsers(split, split.devUserIds, manifest.salt, train, dataset.itemById, params);
  const heldoutContexts = contextsForUsers(split, split.heldoutUserIds, manifest.salt, train, dataset.itemById, params);
  return { train, tuning, params, devContexts, heldoutContexts,
    evaluateDev: (row: UserRanking) => evaluateUser(devScorer, train, row, params.K),
    evaluateHeldout: (row: UserRanking) => evaluateUser(heldoutScorer, train, row, params.K),
    devNdcg: (userKey: string, order: readonly number[]) => ndcgAt10(targetRank(devScorer, userKey, order)),
  };
}
export type PreparedEvaluation = ReturnType<typeof prepareEvaluation>;

/** Mock-only dev selection; a live dev run must use M4's approved persisted lifecycle and cost caps. */
export async function selectMockModels(prepared: PreparedEvaluation, client: RerankClient,
  cfg: Omit<ModelArmConfig, 'promptVersion'>) {
  if (client.mode !== 'mock') throw new Error('selectMockModels is for explicit local mock only');
  const versions = ['llm-list.v1', 'llm-list.v2'] as const;
  const trials: { version: typeof versions[number]; mean: number; values: number[] }[] = [];
  const score = prepared.devNdcg;
  for (const version of versions) {
    const arm = createLlmListArm(client, { ...cfg, runId: `${cfg.runId}-${version}`, promptVersion: version,
      configHash: hashCanonical({ devConfig: cfg.configHash, version }) });
    const values: number[] = [];
    for (const ctx of prepared.devContexts) values.push(score(ctx.userKey, (await arm.rank(ctx)).order));
    // Probe behavior is smoke-tested on dev before freezing the held-out design, never selected using its outcomes.
    for (const ctx of prepared.devContexts.slice(0, 5)) for (const variant of PROBES_BY_ARM['llm-list']) await arm.rank(ctx, { variant });
    trials.push({ version, values, mean: values.length ? values.reduce((s, x) => s + x, 0) / values.length : 0 });
  }
  const best = trials[1].mean > trials[0].mean + 1e-12 ? trials[1] : trials[0];
  const jev = createJevPointArm(client, { ...cfg, runId: `${cfg.runId}-jev`, promptVersion: 'jev-point.v1' });
  const jevValues: number[] = [];
  for (const ctx of prepared.devContexts) jevValues.push(score(ctx.userKey, (await jev.rank(ctx)).order));
  for (const ctx of prepared.devContexts.slice(0, 5)) await jev.rank(ctx, { variant: 'q_shuffle' });
  const jevMean = jevValues.length ? jevValues.reduce((s, x) => s + x, 0) / jevValues.length : 0;
  const primaryArm = jevMean > best.mean + 1e-12 ? 'jev-point' as const : 'llm-list' as const;
  const chosen = primaryArm === 'llm-list' ? best.values : jevValues;
  const devDiffs = chosen.map((value, i) => value - score(prepared.devContexts[i].userKey,
    prepared.devContexts[i].candidates.map((c) => c.itemId)));
  return { llmListPromptVersion: best.version, primaryArm, devDiffs,
    trials: trials.map(({ version, mean }) => ({ version, mean })), jevMean };
}
