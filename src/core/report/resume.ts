// Target-aware reconstruction from a frozen run. Deliberately imports no tuning/model-selection functions.
import { createItemKnnArm } from '../arms/itemknn.ts';
import { createMostPopArm } from '../arms/mostpop.ts';
import { createRandomRerankArm } from '../arms/random-rerank.ts';
import { createTunedRerankArm } from '../arms/tuned-rerank.ts';
import { createLlmListArm } from '../arms/llm-list.ts';
import { createJevPointArm } from '../arms/jev-point.ts';
import { buildTrainingData } from '../arms/train.ts';
import type { Dataset } from '../data/types.ts';
import { evaluateUser, type UserRanking } from '../metrics/ranking.ts';
import type { FrozenConfig } from '../prereg/schema.ts';
import type { CandidateCounts } from '../contracts/frozen-config.ts';
import { sampleProbeUsers } from '../probes/orderprobe.ts';
import type { RerankClient } from '../providers/types.ts';
import { expectedResults } from '../runner/run.ts';
import { resultKey, type ResultKey, type RunIdentity } from '../runner/store.ts';
import { contextsForUsers } from '../split/contexts.ts';
import { loadManifest, splitFromManifest, type Manifest } from '../split/manifest.ts';
import { scorerFromSplit } from '../split/scorer.ts';

export function reconstructFrozenEvaluation(dataset: Dataset, manifest: Manifest, frozen: FrozenConfig, splitName: 'dev' | 'heldout') {
  const checked = loadManifest(manifest, { datasetHash: dataset.hashes.datasetHash });
  if (!checked.ok) throw new Error(checked.error);
  if (manifest.files.uData !== dataset.hashes.uData || manifest.files.uItem !== dataset.hashes.uItem)
    throw new Error('reselected source files differ from frozen manifest');
  if (manifest.seed !== frozen.seed) throw new Error('frozen seed mismatch');
  const derived = splitFromManifest(dataset, checked.manifest);
  if (!derived.ok) throw new Error(derived.error);
  const split = derived.split;
  const train = buildTrainingData(dataset.interactions, manifest.T, dataset.items);
  const ids = splitName === 'dev' ? split.devUserIds : split.heldoutUserIds;
  const contexts = contextsForUsers(split, ids, manifest.salt, train, dataset.itemById, { k: frozen.knnK, K: frozen.K });
  const scorer = scorerFromSplit(split, ids, manifest.salt);
  const probeUserKeys = new Set(sampleProbeUsers(contexts.map((c) => c.userKey), frozen.probeSampleSeed, frozen.probeSampleMax));
  const candidateCounts = contexts.map(({ userKey, kEff }) => ({ userKey, kEff })).sort((a, b) => a.userKey.localeCompare(b.userKey));
  return { train, contexts, probeUserKeys, candidateCounts,
    evaluate: (row: UserRanking) => evaluateUser(scorer, train, row, frozen.K) };
}
export type FrozenEvaluation = ReturnType<typeof reconstructFrozenEvaluation>;
export function createFrozenArms(prepared: FrozenEvaluation, identity: RunIdentity, frozen: FrozenConfig,
  clients: { 'llm-list': RerankClient; 'jev-point': RerankClient }) {
  for (const arm of ['llm-list', 'jev-point'] as const) {
    const client = clients[arm]; const pin = frozen.models[arm];
    if (client.mode !== identity.mode || client.provider !== pin.provider || client.model !== pin.model)
      throw new Error(`${arm}: client differs from frozen provider/model/mode`);
  }
  const cfg = { runId: identity.runId, configHash: identity.configHash, datasetHash: identity.datasetHash, seed: frozen.seed };
  return [createMostPopArm(prepared.train), createItemKnnArm(), createRandomRerankArm(frozen.seed),
    createTunedRerankArm(prepared.train, frozen.knnK, frozen.tunedWeights),
    createLlmListArm(clients['llm-list'], { ...cfg, promptVersion: frozen.llmListPromptVersion }),
    createJevPointArm(clients['jev-point'], { ...cfg, promptVersion: frozen.jevPromptVersion })];
}
export function assertFrozenExpectations(expected: readonly ResultKey[], counts: CandidateCounts, actual: Parameters<typeof expectedResults>[0]): void {
  const wanted = expectedResults(actual).map(resultKey).sort();
  const frozen = expected.map(resultKey).sort();
  if (wanted.length !== frozen.length || wanted.some((key, index) => key !== frozen[index]))
    throw new Error('reconstructed result keys differ from frozen run');
  const byUser = new Map(counts.map((c) => [c.userKey, c.kEff]));
  if (byUser.size !== counts.length || byUser.size !== actual.contexts.length ||
    actual.contexts.some((c) => byUser.get(c.userKey) !== c.kEff)) throw new Error('reconstructed candidate counts differ from frozen run');
}
