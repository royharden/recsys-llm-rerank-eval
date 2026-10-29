// Target-bearing details are reconstructed only for local report/Inspector rendering; never store or send this object to a model.
import type { Dataset } from '../data/types.ts';
import type { RunIdentity } from '../runner/store.ts';
import { loadManifest, splitFromManifest, userKeyOf, type Manifest } from '../split/manifest.ts';
import type { UserSplit } from '../split/temporal.ts';

export interface LocalInspection {
  users: ReadonlyMap<string, UserSplit>;
  targetTitles: ReadonlyMap<string, string>;
}

/** Reuse the stored salt/T/seed and selected split, after checking source and manifest identity against the output. */
export function reconstructLocalInspection(dataset: Dataset | null | undefined, stored: Manifest | null | undefined,
  identity: RunIdentity | null | undefined): LocalInspection | null {
  if (!dataset || !stored || !identity || dataset.hashes.datasetHash !== identity.datasetHash ||
    stored.manifestHash !== identity.manifestHash) return null;
  const checked = loadManifest(stored, { datasetHash: identity.datasetHash });
  if (!checked.ok) return null;
  const manifest = checked.manifest;
  if (manifest.files.uData !== dataset.hashes.uData || manifest.files.uItem !== dataset.hashes.uItem) return null;
  const restored = splitFromManifest(dataset, manifest);
  if (!restored.ok) return null;
  const ids = identity.split === 'dev' ? restored.split.devUserIds : restored.split.heldoutUserIds;
  const users = new Map<string, UserSplit>(); const targetTitles = new Map<string, string>();
  for (const id of ids) {
    const user = restored.split.users.get(id);
    if (!user) continue;
    const key = userKeyOf(manifest.salt, id); users.set(key, user);
    const title = user.target ? dataset.itemById.get(user.target.itemId)?.title : undefined;
    if (title) targetTitles.set(key, title);
  }
  return { users, targetTitles };
}
