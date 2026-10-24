import { generateSynthetic } from '../../src/core/data/synthetic.ts';
import { loadDataset } from '../../src/core/data/movielens.ts';
import { createMemoryCache, createMemoryLedger } from '../../src/core/ledger/memory.ts';
import { configHashOf, FrozenConfigSchema } from '../../src/core/prereg/schema.ts';
import { createMockProvider, createMockRerankClient, mockParams } from '../../src/core/providers/mock.ts';
import { freezeManifest } from '../../src/core/split/manifest.ts';
import { temporalSplit } from '../../src/core/split/temporal.ts';
import { hashCanonical } from '../../src/core/util/hash.ts';
import { preparePersistedConfig } from '../../src/lib/evaluation.ts';
import { validatePersistedRun } from '../../src/lib/run-config.ts';

export function persistedFixture() {
  const fixture = generateSynthetic(38);
  const loaded = loadDataset({ uData: new TextEncoder().encode(fixture.uData), uItem: fixture.uItem });
  if (!loaded.ok) throw new Error(loaded.error);
  const { dataset, report } = loaded;
  const { decision, split } = temporalSplit(dataset.interactions, { seed: 38 });
  const manifest = freezeManifest({ dataset, report, decision, split },
    { randomSaltHex: '0123456789abcdef0123456789abcdef', frozenAt: '2026-10-24T20:00:00.000Z' });
  const frozen = FrozenConfigSchema.parse({ schemaVersion: 1, seed: 38, knnK: 100, K: 30,
    tunedWeights: { knn: 0, recency: 0, genre: 1 }, llmListPromptVersion: 'llm-list.v2', jevPromptVersion: 'jev-point.v1',
    primaryArm: 'jev-point', bootstrapResamples: 10000, practicalMarginNdcg: 0.01, probeSampleSeed: 74, probeSampleMax: 150,
    models: { 'llm-list': { provider: 'mock', model: 'mock-1' }, 'jev-point': { provider: 'mock', model: 'mock-1' } },
    mock: { preset: 'unbiased', seed: 38, forcedModesHash: hashCanonical([]) } });
  const identity = { schemaVersion: 1 as const, runId: 'persisted-test', mode: 'mock' as const, split: 'heldout' as const,
    datasetHash: manifest.datasetHash, manifestHash: manifest.manifestHash, configHash: configHashOf(frozen), preregHash: null };
  const ledger = createMemoryLedger();
  const mock = createMockRerankClient({ adapter: createMockProvider(mockParams('unbiased', 38)), ledger, cache: createMemoryCache() });
  const config = preparePersistedConfig({ identity, dataset, manifest, frozen, prereg: null, devDiffs: [0.2, -0.1, 0.3],
    clients: { 'llm-list': mock, 'jev-point': mock } });
  const run = validatePersistedRun({ id: identity.runId, owner_id: 'd2719c7d-e4ef-4459-9d3c-773a727f2c2a',
    mode: 'mock', split: 'heldout', dataset_hash: identity.datasetHash, manifest_hash: identity.manifestHash,
    config_hash: identity.configHash, prereg_hash: null, prereg_dated_at: null, config,
    state: 'approved', started_at: null, cap_micro: 0, arm_caps: { 'llm-list': 0, 'jev-point': 0, probe: 0 } });
  return { dataset, manifest, frozen, identity, run, ledger, mock };
}
