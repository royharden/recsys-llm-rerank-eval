// Target-aware browser preparation seam. Worker callers receive no targets or Scorer.
import { buildTrainingData } from '../arms/train.ts';
import { tuneNeighbourhood, tuneOnDev } from '../arms/tuning.ts';
import type { ListK } from '../arms/candidates.ts';
import type { Dataset } from '../data/types.ts';
import { judgeFromScorer } from '../metrics/ranking.ts';
import { contextsForUsers, devUsersOf } from '../split/contexts.ts';
import { splitFromManifest, type Manifest } from '../split/manifest.ts';
import { scorerFromSplit } from '../split/scorer.ts';
import type { UserContext } from '../split/context.ts';

export function prepareBrowserDesign(dataset: Dataset, manifest: Manifest, splitName: 'dev' | 'heldout',
  fitsCap: (contexts: readonly UserContext[], K: ListK) => boolean) {
  const loaded = splitFromManifest(dataset, manifest);
  if (!loaded.ok) throw new Error(loaded.error);
  const split = loaded.split;
  const train = buildTrainingData(dataset.interactions, manifest.T, dataset.items);
  const users = devUsersOf(split, split.devUserIds, manifest.salt);
  const judge = judgeFromScorer(scorerFromSplit(split, split.devUserIds, manifest.salt));
  const k = tuneNeighbourhood(train, users, judge);
  const ids = splitName === 'dev' ? split.devUserIds : split.heldoutUserIds;
  const tuning = tuneOnDev({ train, itemById: dataset.itemById, devUsers: users, judge, kGrid: [k.k],
    fitsCap: (K) => fitsCap(contextsForUsers(split, ids, manifest.salt, train, dataset.itemById, { k: k.k, K }), K) });
  // Preserve the full neighbourhood search evidence rather than the one-value second pass.
  tuning.k = k;
  return { tuning, params: { k: k.k, K: tuning.weightsK } };
}
